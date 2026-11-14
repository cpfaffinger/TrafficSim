//! Public transport lines of the network package (#85, ADR-0019): package DTOs and their
//! resolution onto the runtime network.
//!
//! A line is a fixed sequence of links (consecutive links joined by a connector usable by buses)
//! with stops in driving order. Lines are optional data: a line that does not resolve (unknown or
//! disconnected links) is dropped instead of failing the network; so is a stop that does not lie
//! on its line.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::network::{NONE, Network};
use crate::vehicle::VehicleClass;

/// Bus operation on the package's transit lines (`transit` config key).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransitConfig {
    /// Run buses on the package's lines (no effect without lines).
    pub enabled: bool,
    /// Headway (s) of lines without one in the package (no OSM `interval`).
    pub default_headway: f64,
    /// Multiplier on every headway (e.g. 0.5 doubles the service).
    pub headway_factor: f64,
    /// Headway (s) per line id, overriding the package; 0 takes a line out of service.
    pub headways: BTreeMap<String, f64>,
    /// Base dwell time at a stop (s).
    pub dwell_time: f64,
    /// Random part of the dwell time: uniform in [0, dwellTimeRandom) s, from the seeded stream.
    pub dwell_time_random: f64,
    /// Vehicle type of the buses (catalogue name).
    pub vehicle_type: String,
}

impl Default for TransitConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            default_headway: 600.0,
            headway_factor: 1.0,
            headways: BTreeMap::new(),
            dwell_time: 15.0,
            dwell_time_random: 10.0,
            vehicle_type: "bus".into(),
        }
    }
}

impl TransitConfig {
    pub fn validate(&self) -> Result<(), String> {
        let ok = |v: f64| v.is_finite() && v >= 0.0;
        if !(ok(self.dwell_time) && ok(self.dwell_time_random))
            || !(self.default_headway.is_finite() && self.default_headway > 0.0)
            || !(self.headway_factor.is_finite() && self.headway_factor > 0.0)
            || !self.headways.values().all(|&h| ok(h))
        {
            return Err(
                "transit needs non-negative dwell times and headways, a positive defaultHeadway and headwayFactor"
                    .into(),
            );
        }
        Ok(())
    }

    /// Effective headway (s) of `line`, `None` when the line is out of service.
    pub fn headway(&self, line: &Line) -> Option<f64> {
        let h = match self.headways.get(&line.id) {
            Some(&h) => h,
            None => line.headway.unwrap_or(self.default_headway),
        };
        (h > 0.0).then_some(h * self.headway_factor)
    }
}

/// `transitLines[]` of the package.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitLineDto {
    pub id: String,
    #[serde(default, rename = "ref")]
    pub line_ref: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Headway (s) from OSM, `null` when unknown.
    #[serde(default)]
    pub headway: Option<f64>,
    pub links: Vec<String>,
    #[serde(default)]
    pub stops: Vec<TransitStopDto>,
}

/// `transitLines[].stops[]` of the package.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitStopDto {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub link: String,
    pub pos: f64,
    #[serde(default)]
    pub bay: bool,
}

/// A stop on a resolved line.
#[derive(Debug, Clone, PartialEq)]
pub struct Stop {
    pub id: String,
    pub name: Option<String>,
    /// Index into [`Line::links`] of the link the stop lies on.
    pub route_pos: u32,
    pub link: u32,
    /// Distance along the link (m, in the link's nominal length).
    pub pos: f64,
    pub bay: bool,
}

/// A resolved line: link indices and stops in driving order.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub id: String,
    /// Line number, else the name (for reports).
    pub label: Option<String>,
    /// Headway (s) from the package.
    pub headway: Option<f64>,
    pub links: Vec<u32>,
    pub stops: Vec<Stop>,
}

/// Resolves the package lines onto `net`, dropping lines that do not form a connected bus path.
pub fn resolve(net: &Network, lines: &[TransitLineDto]) -> Vec<Line> {
    let bus = VehicleClass::Bus.mask();
    let mut result = Vec::new();
    for dto in lines {
        let Some(links) = dto
            .links
            .iter()
            .map(|id| net.link_index(id))
            .collect::<Option<Vec<u32>>>()
        else {
            continue;
        };
        let usable = !links.is_empty()
            && links.iter().all(|&l| net.links[l as usize].class_mask & bus != 0)
            && links.windows(2).all(|w| connected(net, w[0], w[1], bus));
        if !usable {
            continue;
        }
        let mut stops = Vec::new();
        let mut from = 0usize;
        let mut from_pos = f64::NEG_INFINITY;
        for s in &dto.stops {
            let Some(link) = net.link_index(&s.link) else {
                continue;
            };
            let len = net.links[link as usize].length;
            let pos = if s.pos.is_finite() {
                s.pos.clamp(0.0, len)
            } else {
                continue;
            };
            let Some(k) = (from..links.len()).find(|&k| links[k] == link && (k > from || pos >= from_pos))
            else {
                continue;
            };
            stops.push(Stop {
                id: s.id.clone(),
                name: s.name.clone(),
                route_pos: k as u32,
                link,
                pos,
                bay: s.bay,
            });
            (from, from_pos) = (k, pos);
        }
        result.push(Line {
            id: dto.id.clone(),
            label: dto.line_ref.clone().or_else(|| dto.name.clone()),
            headway: dto.headway.filter(|h| h.is_finite() && *h > 0.0),
            links,
            stops,
        });
    }
    result
}

/// Whether some lane of `a` reaches `b` through a connector open to `mask`.
fn connected(net: &Network, a: u32, b: u32, mask: u8) -> bool {
    let info = &net.links[a as usize];
    (info.first_lane..info.first_lane + info.lane_count).any(|l| net.choose_connector(l, b, mask) != NONE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::Package;
    use crate::synth::{TRANSIT_FIXTURE, corridor};

    fn dto(links: &[&str], stops: &[(&str, f64, bool)]) -> TransitLineDto {
        TransitLineDto {
            id: "t0".into(),
            line_ref: Some("1".into()),
            name: None,
            headway: Some(300.0),
            links: links.iter().map(|s| s.to_string()).collect(),
            stops: stops
                .iter()
                .enumerate()
                .map(|(i, &(link, pos, bay))| TransitStopDto {
                    id: format!("s{i}"),
                    name: None,
                    link: link.into(),
                    pos,
                    bay,
                })
                .collect(),
        }
    }

    #[test]
    fn parses_and_resolves_the_transit_fixture() {
        let p = Package::from_json(TRANSIT_FIXTURE).unwrap();
        assert_eq!(p.transit_lines.len(), 1);
        let l = &p.transit_lines[0];
        assert_eq!(
            (l.line_ref.as_deref(), l.headway, l.stops.len()),
            (Some("13A"), Some(300.0), 2)
        );
        let net = Network::from_package(&p).unwrap();
        let line = &net.transit[0];
        assert_eq!(line.label.as_deref(), Some("13A"));
        assert_eq!(line.links, vec![0, 1]);
        assert_eq!(
            line.stops
                .iter()
                .map(|s| (s.route_pos, s.pos, s.bay))
                .collect::<Vec<_>>(),
            vec![(0, 150.0, false), (1, 200.0, true)]
        );
    }

    #[test]
    fn drops_unresolvable_lines_and_stops() {
        let net = corridor(2, 300.0, 13.89).network();
        let lines = [
            dto(&["up", "nowhere"], &[]),
            dto(&["down", "up"], &[]),
            dto(&[], &[]),
            dto(
                &["up", "down"],
                &[
                    ("down", 50.0, false),
                    ("up", 100.0, false),
                    ("x", 1.0, false),
                    ("down", 900.0, true),
                    ("down", f64::NAN, false),
                ],
            ),
        ];
        let resolved = resolve(&net, &lines);
        assert_eq!(resolved.len(), 1);
        let stops: Vec<_> = resolved[0]
            .stops
            .iter()
            .map(|s| (s.id.as_str(), s.route_pos, s.pos))
            .collect();
        // "up" at 100 m lies behind the first stop on "down": out of order, dropped.
        assert_eq!(stops, vec![("s0", 1, 50.0), ("s3", 1, 300.0)]);
    }

    #[test]
    fn a_link_closed_to_buses_breaks_the_line() {
        let mut b = corridor(1, 300.0, 13.89);
        b.link_mut("down").lanes[0].allowed = vec![crate::package::VehicleClassDto::Car];
        assert!(resolve(&b.network(), &[dto(&["up", "down"], &[])]).is_empty());
    }
}
