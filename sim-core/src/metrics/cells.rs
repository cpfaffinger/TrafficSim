//! Lane-cell aggregation (#57) and the binary bucket format `lane-cells-v1`.
//!
//! Every lane is split into cells of `cellLength` metres (the last cell of a lane may be
//! shorter). Per cell and time bucket the simulation accumulates vehicle-seconds, speed,
//! lost time, queue presence, stops and boundary crossings (see `sim-core/README.md`).
//!
//! # `lane-cells-v1` (little endian)
//!
//! | Offset | Type | Field |
//! |--------|------|-------|
//! | 0 | `u8[4]` | magic `"LCV1"` |
//! | 4 | `u16` | version (1) |
//! | 6 | `u16` | header size in bytes (48) |
//! | 8 | `u32` | lane count `L` |
//! | 12 | `u32` | cell count `C` |
//! | 16 | `u32` | bucket count `B` in this blob |
//! | 20 | `u32` | index of the first bucket in the run |
//! | 24 | `f32` | nominal cell length (m) |
//! | 28 | `f32` | bucket duration (s) |
//! | 32 | `f64` | time of day at simulation time 0 (s since midnight) |
//! | 40 | `u32` | field mask (`0x7f`: the seven fields below) |
//! | 44 | `u32` | reserved (0) |
//! | 48 | `L × 20` | lane table: `u32` link index (package `links[]` order), `u16` lane index, `u16` cell count, `u32` first cell, `f32` lane length (m), `f32` speed limit (m/s) |
//! | 48 + 20 L | `B ×` block | buckets, oldest first |
//!
//! A bucket block holds field-major arrays of `C` values: `f32` density (veh/km), `f32` mean
//! speed (m/s, NaN = no vehicle), `f32` speed ratio `v / v_limit` (NaN = no vehicle), `f32` delay
//! (vehicle-seconds lost against the speed limit), `u16` queue share (1/10000 of the bucket),
//! `u16` stops, `u16` flow (vehicles crossing the cell's downstream boundary), then zero padding
//! to a multiple of 4 bytes. Block size: `16 C + pad4(6 C)`. Every array starts 4-byte aligned,
//! so `Float32Array` / `Uint16Array` views work directly on the bytes.

use crate::network::Network;

pub const MAGIC: [u8; 4] = *b"LCV1";
pub const VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 48;
pub const LANE_ENTRY_BYTES: usize = 20;
pub const FIELD_MASK: u32 = 0x7f;
/// Speed (m/s) below which a vehicle counts as stopped.
pub const STOP_SPEED: f64 = 0.5;

/// One lane of the lane table.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LaneEntry {
    pub link: u32,
    pub lane: u16,
    pub cells: u16,
    pub first_cell: u32,
    pub length: f32,
    pub speed_limit: f32,
}

/// Cell layout of a network (lane order = global lane index).
#[derive(Debug, Clone, PartialEq)]
pub struct CellLayout {
    pub cell_length: f64,
    inv_cell_length: f64,
    pub lanes: Vec<LaneEntry>,
    pub cell_count: usize,
    /// Actual length of every cell (m).
    pub cell_len: Vec<f64>,
    /// Speed limit of the lane of every cell (m/s).
    pub cell_limit: Vec<f64>,
}

impl CellLayout {
    pub fn new(net: &Network, cell_length: f64) -> Result<Self, String> {
        let mut lanes = Vec::with_capacity(net.lane_count());
        let (mut cell_len, mut cell_limit) = (Vec::new(), Vec::new());
        for (i, lane) in net.lanes.iter().enumerate() {
            let length = net.seg_length[i];
            let limit = net.seg_speed_limit[i];
            let cells = (length / cell_length).ceil().max(1.0) as usize;
            if cells > usize::from(u16::MAX) {
                return Err(format!(
                    "lane {i} needs {cells} cells; increase metrics.cellLength"
                ));
            }
            lanes.push(LaneEntry {
                link: lane.link,
                lane: lane.index as u16,
                cells: cells as u16,
                first_cell: cell_len.len() as u32,
                length: length as f32,
                speed_limit: limit as f32,
            });
            for k in 0..cells {
                cell_len.push((length - k as f64 * cell_length).min(cell_length).max(1e-3));
                cell_limit.push(limit);
            }
        }
        Ok(Self {
            cell_length,
            inv_cell_length: 1.0 / cell_length,
            lanes,
            cell_count: cell_len.len(),
            cell_len,
            cell_limit,
        })
    }

    /// Cell of position `pos` (m) on `lane`.
    #[inline]
    pub fn cell(&self, lane: u32, pos: f64) -> usize {
        let e = &self.lanes[lane as usize];
        let k = (pos.max(0.0) * self.inv_cell_length) as usize;
        e.first_cell as usize + k.min(usize::from(e.cells) - 1)
    }

    /// Last cell of `lane`.
    #[inline]
    pub fn last_cell(&self, lane: u32) -> usize {
        let e = &self.lanes[lane as usize];
        e.first_cell as usize + usize::from(e.cells) - 1
    }

    pub fn first_cell(&self, lane: u32) -> usize {
        self.lanes[lane as usize].first_cell as usize
    }
}

/// Accumulators of one cell in the current bucket (32 bytes: one vehicle-step touches a single
/// cache line).
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C, align(32))]
pub struct Cell {
    /// Vehicle-seconds.
    pub veh_s: f32,
    /// Vehicle-metres (Σ v·dt).
    pub speed_s: f32,
    /// Vehicle-seconds lost against the speed limit.
    pub delay_s: f32,
    /// Seconds with at least one queued vehicle.
    pub queue_s: f32,
    pub stops: u32,
    /// Crossings of the downstream boundary.
    pub flow: u32,
    inv_limit: f32,
    mark: u32,
}

/// Per-cell accumulators of the current bucket.
#[derive(Debug, Clone, PartialEq)]
pub struct CellAccumulator {
    pub cells: Vec<Cell>,
}

impl CellAccumulator {
    pub fn new(layout: &CellLayout) -> Self {
        Self {
            cells: layout
                .cell_limit
                .iter()
                .map(|&limit| Cell {
                    veh_s: 0.0,
                    speed_s: 0.0,
                    delay_s: 0.0,
                    queue_s: 0.0,
                    stops: 0,
                    flow: 0,
                    inv_limit: (1.0 / limit) as f32,
                    mark: u32::MAX,
                })
                .collect(),
        }
    }

    pub fn reset(&mut self) {
        for c in &mut self.cells {
            *c = Cell {
                inv_limit: c.inv_limit,
                ..Cell {
                    veh_s: 0.0,
                    speed_s: 0.0,
                    delay_s: 0.0,
                    queue_s: 0.0,
                    stops: 0,
                    flow: 0,
                    inv_limit: 0.0,
                    mark: u32::MAX,
                }
            };
        }
    }

    /// Crossings of the downstream boundaries of cells `from..to`.
    #[inline]
    pub fn cross(&mut self, from: usize, to: usize) {
        for c in &mut self.cells[from..to] {
            c.flow += 1;
        }
    }

    /// One vehicle in `cell` during a step of `dt` seconds (step number `step`).
    #[inline]
    pub fn occupy(&mut self, cell: usize, dt: f32, speed: f32, old_speed: f32, queue_speed: f32, step: u64) {
        let c = &mut self.cells[cell];
        c.veh_s += dt;
        c.speed_s += speed * dt;
        c.delay_s += dt * (1.0 - speed * c.inv_limit).max(0.0);
        if old_speed >= STOP_SPEED as f32 && speed < STOP_SPEED as f32 {
            c.stops += 1;
        }
        let step = step as u32;
        if speed < queue_speed && c.mark != step {
            c.mark = step;
            c.queue_s += dt;
        }
    }
}

fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

/// Size of one bucket block for `cells` cells.
pub fn bucket_bytes(cells: usize) -> usize {
    16 * cells + pad4(6 * cells)
}

/// Appends the bucket block of `acc` (bucket of `duration` seconds) to `out`.
pub fn encode_bucket(layout: &CellLayout, acc: &CellAccumulator, duration: f64, out: &mut Vec<u8>) {
    let start = out.len();
    out.reserve(bucket_bytes(layout.cell_count));
    let cells = &acc.cells;
    let mean = |c: &Cell| {
        if c.veh_s > 0.0 {
            f64::from(c.speed_s) / f64::from(c.veh_s)
        } else {
            f64::NAN
        }
    };
    let mut put = |x: f64| out.extend_from_slice(&(x as f32).to_le_bytes());
    for (c, len) in cells.iter().zip(&layout.cell_len) {
        put(f64::from(c.veh_s) / (duration * len) * 1000.0);
    }
    cells.iter().for_each(|c| put(mean(c)));
    for (c, limit) in cells.iter().zip(&layout.cell_limit) {
        put(mean(c) / limit);
    }
    cells.iter().for_each(|c| put(f64::from(c.delay_s)));
    let mut put16 = |v: u32| out.extend_from_slice(&(v.min(u32::from(u16::MAX)) as u16).to_le_bytes());
    for c in cells {
        let share = (f64::from(c.queue_s) / duration * 10_000.0)
            .round()
            .clamp(0.0, 10_000.0);
        put16(share as u32);
    }
    cells.iter().for_each(|c| put16(c.stops));
    cells.iter().for_each(|c| put16(c.flow));
    out.resize(start + bucket_bytes(layout.cell_count), 0);
}

/// Builds a `lane-cells-v1` blob from encoded bucket blocks.
pub fn encode<'a>(
    layout: &CellLayout,
    start_time_of_day: f64,
    bucket_duration: f64,
    first_bucket: u64,
    blocks: impl ExactSizeIterator<Item = &'a [u8]>,
) -> Vec<u8> {
    let count = blocks.len();
    let mut out = Vec::with_capacity(
        HEADER_BYTES + LANE_ENTRY_BYTES * layout.lanes.len() + count * bucket_bytes(layout.cell_count),
    );
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&(HEADER_BYTES as u16).to_le_bytes());
    out.extend_from_slice(&(layout.lanes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(layout.cell_count as u32).to_le_bytes());
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.extend_from_slice(&(first_bucket as u32).to_le_bytes());
    out.extend_from_slice(&(layout.cell_length as f32).to_le_bytes());
    out.extend_from_slice(&(bucket_duration as f32).to_le_bytes());
    out.extend_from_slice(&start_time_of_day.to_le_bytes());
    out.extend_from_slice(&FIELD_MASK.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for e in &layout.lanes {
        out.extend_from_slice(&e.link.to_le_bytes());
        out.extend_from_slice(&e.lane.to_le_bytes());
        out.extend_from_slice(&e.cells.to_le_bytes());
        out.extend_from_slice(&e.first_cell.to_le_bytes());
        out.extend_from_slice(&e.length.to_le_bytes());
        out.extend_from_slice(&e.speed_limit.to_le_bytes());
    }
    for b in blocks {
        out.extend_from_slice(b);
    }
    out
}

/// One decoded bucket.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Bucket {
    pub density: Vec<f32>,
    pub mean_speed: Vec<f32>,
    pub speed_ratio: Vec<f32>,
    pub delay: Vec<f32>,
    pub queue_share: Vec<u16>,
    pub stops: Vec<u16>,
    pub flow: Vec<u16>,
}

/// A decoded `lane-cells-v1` blob (for tests, the batch runner and consumers in Rust).
#[derive(Debug, Clone, PartialEq)]
pub struct LaneCells {
    pub cell_count: usize,
    pub first_bucket: u32,
    pub cell_length: f32,
    pub bucket_duration: f32,
    pub start_time_of_day: f64,
    pub lanes: Vec<LaneEntry>,
    pub buckets: Vec<Bucket>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let s = self
            .bytes
            .get(self.at..self.at + N)
            .ok_or("lane-cells-v1: unexpected end of data")?;
        self.at += N;
        let mut a = [0; N];
        a.copy_from_slice(s);
        Ok(a)
    }
    fn u16(&mut self) -> Result<u16, String> {
        self.take().map(u16::from_le_bytes)
    }
    fn u32(&mut self) -> Result<u32, String> {
        self.take().map(u32::from_le_bytes)
    }
    fn f32(&mut self) -> Result<f32, String> {
        self.take().map(f32::from_le_bytes)
    }
    fn f64(&mut self) -> Result<f64, String> {
        self.take().map(f64::from_le_bytes)
    }
    fn f32s(&mut self, n: usize) -> Result<Vec<f32>, String> {
        (0..n).map(|_| self.f32()).collect()
    }
    fn u16s(&mut self, n: usize) -> Result<Vec<u16>, String> {
        (0..n).map(|_| self.u16()).collect()
    }
}

impl LaneCells {
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = Reader { bytes, at: 0 };
        if r.take::<4>()? != MAGIC {
            return Err("not a lane-cells-v1 blob".into());
        }
        if r.u16()? != VERSION {
            return Err("unsupported lane-cells version".into());
        }
        let header = r.u16()? as usize;
        let lanes = r.u32()? as usize;
        let cells = r.u32()? as usize;
        let count = r.u32()? as usize;
        let first_bucket = r.u32()?;
        let cell_length = r.f32()?;
        let bucket_duration = r.f32()?;
        let start_time_of_day = r.f64()?;
        r.at = header;
        let mut decoded = Self {
            cell_count: cells,
            first_bucket,
            cell_length,
            bucket_duration,
            start_time_of_day,
            lanes: Vec::with_capacity(lanes),
            buckets: Vec::with_capacity(count),
        };
        for _ in 0..lanes {
            decoded.lanes.push(LaneEntry {
                link: r.u32()?,
                lane: r.u16()?,
                cells: r.u16()?,
                first_cell: r.u32()?,
                length: r.f32()?,
                speed_limit: r.f32()?,
            });
        }
        for _ in 0..count {
            let start = r.at;
            decoded.buckets.push(Bucket {
                density: r.f32s(cells)?,
                mean_speed: r.f32s(cells)?,
                speed_ratio: r.f32s(cells)?,
                delay: r.f32s(cells)?,
                queue_share: r.u16s(cells)?,
                stops: r.u16s(cells)?,
                flow: r.u16s(cells)?,
            });
            r.at = start + bucket_bytes(cells);
        }
        if r.at != bytes.len() {
            return Err("lane-cells-v1: trailing or missing bytes".into());
        }
        Ok(decoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synth::corridor;

    #[test]
    fn layout_splits_lanes_into_cells() {
        let net = corridor(2, 95.0, 10.0).network();
        let l = CellLayout::new(&net, 10.0).unwrap();
        assert_eq!(l.lanes.len(), 4);
        assert_eq!(l.lanes[0].cells, 10);
        assert_eq!(l.cell_count, 40);
        assert_eq!(l.lanes[1].first_cell, 10);
        assert_eq!(l.lanes[2].link, 1);
        assert!((l.cell_len[9] - 5.0).abs() < 1e-9, "last cell is shorter");
        assert_eq!(l.cell(1, 0.0), 10);
        assert_eq!(l.cell(1, 19.9), 11);
        assert_eq!(l.cell(1, 500.0), 19, "clamped to the lane");
        assert_eq!(l.cell(1, -1.0), 10);
        assert_eq!((l.first_cell(2), l.last_cell(2)), (20, 29));
        assert!(CellLayout::new(&corridor(1, 70_000.0, 10.0).network(), 1.0).is_err());
    }

    #[test]
    fn accumulators_and_round_trip_through_the_format() {
        let net = corridor(1, 25.0, 10.0).network();
        let layout = CellLayout::new(&net, 10.0).unwrap();
        assert_eq!(layout.cell_count, 6);
        let mut acc = CellAccumulator::new(&layout);
        // One vehicle standing in cell 1 for the whole 10 s bucket, one passing cell 0 at 10 m/s.
        for step in 0..100 {
            acc.occupy(1, 0.1, 0.0, if step == 0 { 3.0 } else { 0.0 }, 2.0, step);
            acc.occupy(1, 0.1, 0.0, 0.0, 2.0, step);
        }
        acc.occupy(0, 0.1, 10.0, 10.0, 2.0, 0);
        acc.cross(0, 2);
        let mut block = Vec::new();
        encode_bucket(&layout, &acc, 10.0, &mut block);
        assert_eq!(block.len(), bucket_bytes(6));
        assert_eq!(bucket_bytes(6), 96 + 36);
        assert_eq!(bucket_bytes(5), 80 + 32, "u16 arrays padded to 4 bytes");
        let blob = encode(
            &layout,
            25_200.0,
            10.0,
            7,
            [block.as_slice(), block.as_slice()].into_iter(),
        );
        assert_eq!(
            blob.len(),
            HEADER_BYTES + 2 * LANE_ENTRY_BYTES + 2 * bucket_bytes(6)
        );
        let d = LaneCells::decode(&blob).unwrap();
        assert_eq!((d.cell_count, d.first_bucket, d.buckets.len()), (6, 7, 2));
        assert_eq!(
            (d.cell_length, d.bucket_duration, d.start_time_of_day),
            (10.0, 10.0, 25_200.0)
        );
        assert_eq!(d.lanes, layout.lanes);
        let b = &d.buckets[0];
        // Two vehicles for 10 s in a 10 m cell: 200 veh/km.
        assert!((b.density[1] - 200.0).abs() < 0.05, "{}", b.density[1]);
        assert_eq!(b.mean_speed[1], 0.0);
        assert_eq!(b.speed_ratio[1], 0.0);
        assert!((b.delay[1] - 20.0).abs() < 0.01);
        assert_eq!(b.queue_share[1], 10_000);
        assert_eq!(b.stops[1], 1);
        assert_eq!(b.flow[..3], [1, 1, 0]);
        assert_eq!(b.mean_speed[0], 10.0);
        assert_eq!(b.speed_ratio[0], 1.0);
        assert!(b.mean_speed[2].is_nan() && b.speed_ratio[2].is_nan());
        assert_eq!(b.density[2], 0.0);
        acc.reset();
        assert!(
            acc.cells
                .iter()
                .all(|c| c.veh_s == 0.0 && c.flow == 0 && c.inv_limit == 0.1)
        );
        assert_eq!(std::mem::size_of::<Cell>(), 32);
    }

    #[test]
    fn decoding_rejects_foreign_or_truncated_data() {
        let net = corridor(1, 25.0, 10.0).network();
        let layout = CellLayout::new(&net, 10.0).unwrap();
        let blob = encode(&layout, 0.0, 30.0, 0, std::iter::empty());
        assert_eq!(LaneCells::decode(&blob).unwrap().buckets.len(), 0);
        assert!(
            LaneCells::decode(b"XXXX")
                .unwrap_err()
                .contains("not a lane-cells")
        );
        assert!(
            LaneCells::decode(&blob[..20])
                .unwrap_err()
                .contains("end of data")
        );
        let mut v2 = blob.clone();
        v2[4] = 2;
        assert!(LaneCells::decode(&v2).unwrap_err().contains("version"));
        let mut long = blob.clone();
        long.push(0);
        assert!(LaneCells::decode(&long).unwrap_err().contains("trailing"));
    }
}
