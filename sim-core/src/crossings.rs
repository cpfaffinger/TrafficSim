//! Pedestrian crossings of the runtime network (ADR-0020, #86), built from the package's optional
//! `crossings[]`. The dynamics live in `sim/pedestrians.rs`.

use std::collections::BTreeMap;

use crate::network::{NONE, Network, NetworkError};
use crate::package::{self, CrossingSignalMode, Point};

/// How pedestrians and vehicles share a crossing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrossingKind {
    /// Vehicles stop for pedestrians on and waiting at the crossing.
    Zebra,
    /// Pedestrians walk on their signal aspect; vehicles yield to them on the crossing.
    Signal,
    /// Pedestrians wait for a gap in the traffic (marked crossings without priority).
    Uncontrolled,
    /// Pedestrians wait for a gap (unmarked crossing points).
    Unmarked,
}

/// Relation of a signalised crossing to its signal group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalMode {
    /// Not signalised (a `signal` crossing without group behaves like a zebra crossing).
    None,
    /// Pedestrians walk during the group's green (junction crosswalks).
    Parallel,
    /// Pedestrians request a phase that turns the group red (mid-block push-button signals).
    Request,
}

/// Pedestrian behaviour at a crossing, derived from kind and signal mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    /// Pedestrian priority: vehicles stop for waiting pedestrians.
    Priority,
    /// Signal aspect for pedestrians.
    Signal,
    /// Gap acceptance by pedestrians.
    Gap,
}

/// One directional link crossed by a crossing.
#[derive(Debug, Clone, PartialEq)]
pub struct CrossingEntry {
    pub crossing: u32,
    pub link: u32,
    /// Distance of the crossing centre from the link start (m, measured on the link).
    pub pos: f64,
    /// Lateral extent of the link's lanes along the crossing (m from the first kerb).
    pub span: (f64, f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrossingInfo {
    pub id: String,
    pub kind: CrossingKind,
    pub mode: SignalMode,
    /// Signal group index, [`NONE`] if not signalised.
    pub signal_group: u32,
    /// Kerb-to-kerb walking distance (m).
    pub width: f64,
    /// Extent along the road (m).
    pub depth: f64,
    /// Package estimate of pedestrians per hour (both directions).
    pub demand: f64,
    pub geometry: Vec<Point>,
    /// Entries (index range into [`Crossings::entries`]) sorted by span start.
    pub entries: (u32, u32),
}

impl CrossingInfo {
    pub fn rule(&self) -> Rule {
        match (self.kind, self.signal_group) {
            (CrossingKind::Signal, g) if g != NONE => Rule::Signal,
            (CrossingKind::Zebra | CrossingKind::Signal, _) => Rule::Priority,
            _ => Rule::Gap,
        }
    }
}

/// All crossings of a network with a per-link index.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Crossings {
    pub list: Vec<CrossingInfo>,
    pub entries: Vec<CrossingEntry>,
    /// Entry indices per link, sorted by position.
    by_link: Vec<Vec<u32>>,
    index: BTreeMap<String, u32>,
}

impl Crossings {
    /// Builds and validates the crossings of `net` (links and signal groups must exist).
    pub fn build(
        crossings: &[package::Crossing],
        net: &Network,
        group_index: &BTreeMap<String, u32>,
    ) -> Result<Self, NetworkError> {
        let mut out = Self {
            by_link: vec![Vec::new(); net.links.len()],
            ..Self::default()
        };
        let fail = |msg: String| Err(NetworkError(msg));
        for x in crossings {
            let idx = out.list.len() as u32;
            if out.index.insert(x.id.clone(), idx).is_some() {
                return fail(format!("duplicate crossing id '{}'", x.id));
            }
            if !(x.width.is_finite() && x.width > 0.0) || x.links.is_empty() {
                return fail(format!(
                    "crossing '{}' needs a positive width and at least one link",
                    x.id
                ));
            }
            let kind = match x.kind {
                package::CrossingKind::Zebra => CrossingKind::Zebra,
                package::CrossingKind::Signal => CrossingKind::Signal,
                package::CrossingKind::Uncontrolled => CrossingKind::Uncontrolled,
                package::CrossingKind::Unmarked | package::CrossingKind::Unknown => CrossingKind::Unmarked,
            };
            let signal_group = match &x.signal_group {
                Some(g) => *group_index.get(g).ok_or_else(|| {
                    NetworkError(format!(
                        "crossing '{}' references unknown signal group '{g}'",
                        x.id
                    ))
                })?,
                None => NONE,
            };
            let mode = match (signal_group, x.signal_mode) {
                (NONE, _) => SignalMode::None,
                (_, Some(CrossingSignalMode::Request)) => SignalMode::Request,
                _ => SignalMode::Parallel,
            };
            let start = out.entries.len() as u32;
            let mut entries = Vec::with_capacity(x.links.len());
            for l in &x.links {
                let link = net.link_index(&l.link).ok_or_else(|| {
                    NetworkError(format!(
                        "crossing '{}' references unknown link '{}'",
                        x.id, l.link
                    ))
                })?;
                let length = net.links[link as usize].length;
                let [a, b] = l.span;
                if !(l.position.is_finite() && a.is_finite() && b.is_finite() && a < b) {
                    return fail(format!("crossing '{}' has an invalid link entry", x.id));
                }
                entries.push(CrossingEntry {
                    crossing: idx,
                    link,
                    pos: l.position.clamp(0.0, length),
                    span: (a.max(0.0), b.min(x.width).max(a.max(0.0))),
                });
            }
            entries.sort_by(|p, q| p.span.0.total_cmp(&q.span.0));
            out.entries.extend(entries);
            out.list.push(CrossingInfo {
                id: x.id.clone(),
                kind,
                mode,
                signal_group,
                width: x.width,
                depth: if x.depth.is_finite() && x.depth > 0.0 {
                    x.depth
                } else {
                    3.0
                },
                demand: if x.demand.is_finite() {
                    x.demand.max(0.0)
                } else {
                    0.0
                },
                geometry: x.geometry.clone(),
                entries: (start, out.entries.len() as u32),
            });
        }
        for (e, entry) in out.entries.iter().enumerate() {
            out.by_link[entry.link as usize].push(e as u32);
        }
        let entries = &out.entries;
        for list in &mut out.by_link {
            list.sort_by(|&a, &b| {
                entries[a as usize]
                    .pos
                    .total_cmp(&entries[b as usize].pos)
                    .then(a.cmp(&b))
            });
        }
        Ok(out)
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    /// Crossing index by id.
    pub fn index(&self, id: &str) -> Option<u32> {
        self.index.get(id).copied()
    }

    /// Entry indices on `link`, sorted by position.
    pub fn on_link(&self, link: u32) -> &[u32] {
        self.by_link.get(link as usize).map_or(&[], Vec::as_slice)
    }

    /// Entry indices of crossing `x`, sorted by span start (first kerb first).
    pub fn entries_of(&self, x: u32) -> std::ops::Range<usize> {
        let (a, b) = self.list[x as usize].entries;
        a as usize..b as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::NodeControl;
    use crate::package::{CrossingLink, Package};
    use crate::synth::NetBuilder;

    fn crossing(id: &str, kind: package::CrossingKind, links: &[(&str, f64, [f64; 2])]) -> package::Crossing {
        package::Crossing {
            id: id.into(),
            kind,
            signal_group: None,
            signal_mode: None,
            width: 6.5,
            depth: 3.0,
            demand: 100.0,
            geometry: vec![[0.0, 0.0, 0.0], [0.0, 6.5, 0.0]],
            links: links
                .iter()
                .map(|&(l, p, s)| CrossingLink {
                    link: l.into(),
                    position: p,
                    span: s,
                })
                .collect(),
        }
    }

    fn road() -> NetBuilder {
        let mut b = NetBuilder::new();
        b.node("A", 0.0, 0.0, NodeControl::Boundary)
            .node("B", 400.0, 0.0, NodeControl::Boundary)
            .link("ab", "A", "B", 1, 13.9)
            .link("ba", "B", "A", 1, 13.9);
        b
    }

    fn build(p: &Package) -> Result<Network, NetworkError> {
        Network::from_package(p)
    }

    #[test]
    fn builds_crossings_with_entries_per_link() {
        let mut b = road();
        b.package.crossings = Some(vec![
            crossing(
                "x0",
                package::CrossingKind::Zebra,
                &[("ba", 200.0, [3.25, 6.5]), ("ab", 200.0, [0.0, 3.25])],
            ),
            crossing("x1", package::CrossingKind::Unknown, &[("ab", 50.0, [0.0, 3.25])]),
        ]);
        let net = build(&b.build()).unwrap();
        let c = &net.crossings;
        assert_eq!(c.len(), 2);
        assert_eq!(c.index("x1"), Some(1));
        let x0: Vec<_> = c.entries_of(0).map(|e| c.entries[e].link).collect();
        assert_eq!(x0, vec![0, 1], "sorted by span start");
        assert_eq!(c.list[0].rule(), Rule::Priority);
        assert_eq!(c.list[1].kind, CrossingKind::Unmarked);
        assert_eq!(c.list[1].rule(), Rule::Gap);
        let on_ab: Vec<f64> = c.on_link(0).iter().map(|&e| c.entries[e as usize].pos).collect();
        assert_eq!(on_ab, vec![50.0, 200.0]);
        assert!(c.on_link(99).is_empty());
    }

    #[test]
    fn signal_crossings_resolve_groups_and_modes() {
        let mut b = road();
        b.signal("B", 90.0, &[("g0", 0.0, 60.0, 3.0)]);
        let mut request = crossing("x0", package::CrossingKind::Signal, &[("ab", 390.0, [0.0, 3.25])]);
        request.signal_group = Some("g0".into());
        request.signal_mode = Some(CrossingSignalMode::Request);
        let mut parallel = request.clone();
        parallel.id = "x1".into();
        parallel.signal_mode = None;
        let mut orphan = request.clone();
        orphan.id = "x2".into();
        orphan.signal_group = None;
        b.package.crossings = Some(vec![request, parallel, orphan]);
        let net = build(&b.build()).unwrap();
        let l = &net.crossings.list;
        assert_eq!((l[0].mode, l[0].rule()), (SignalMode::Request, Rule::Signal));
        assert_eq!(l[1].mode, SignalMode::Parallel);
        assert_eq!((l[2].mode, l[2].rule()), (SignalMode::None, Rule::Priority));
    }

    #[test]
    fn rejects_invalid_crossings() {
        let check = |x: package::Crossing, needle: &str| {
            let mut b = road();
            b.package.crossings = Some(vec![x]);
            let e = build(&b.build()).unwrap_err();
            assert!(e.0.contains(needle), "{e}");
        };
        let ok = crossing("x0", package::CrossingKind::Zebra, &[("ab", 10.0, [0.0, 3.25])]);
        check(
            crossing("x0", package::CrossingKind::Zebra, &[("zz", 10.0, [0.0, 3.25])]),
            "unknown link",
        );
        check(
            crossing("x0", package::CrossingKind::Zebra, &[("ab", 10.0, [3.0, 1.0])]),
            "invalid link entry",
        );
        check(
            package::Crossing {
                width: 0.0,
                ..ok.clone()
            },
            "positive width",
        );
        check(
            package::Crossing {
                signal_group: Some("nope".into()),
                ..ok.clone()
            },
            "unknown signal group",
        );
        let mut b = road();
        b.package.crossings = Some(vec![ok.clone(), ok]);
        assert!(build(&b.build()).unwrap_err().0.contains("duplicate crossing"));
    }
}
