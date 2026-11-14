//! Network package format v1 (`docs/architecture/network-package.md`): serde data transfer types.
//!
//! These types mirror the JSON contract one to one. Unknown keys are ignored (forward
//! compatibility within v1); unknown enum values map to an `Unknown` variant where the simulation
//! can fall back to a sensible default. Semantic validation (references, ranges) happens when the
//! runtime graph is built, see [`crate::network::Network::from_package`].

use serde::Deserialize;

/// The only format version this crate understands.
pub const FORMAT_VERSION: u32 = 1;

pub type Point = [f64; 3];

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub format_version: u32,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub connectors: Vec<Connector>,
    #[serde(default)]
    pub signals: Vec<SignalController>,
    /// Public transport lines (#85), optional.
    #[serde(default)]
    pub transit_lines: Vec<crate::transit::TransitLineDto>,
    /// Pedestrian crossings (ADR-0020); absent (or null) in older packages.
    #[serde(default)]
    pub crossings: Option<Vec<Crossing>>,
}

impl Package {
    /// Parses a package from JSON. Only syntax and types are checked here.
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("invalid network package JSON: {e}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeControl {
    None,
    Priority,
    RightBeforeLeft,
    AllWayStop,
    Signal,
    Roundabout,
    LevelCrossing,
    Boundary,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub z: f64,
    pub control: NodeControl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoadClass {
    Motorway,
    MotorwayLink,
    Trunk,
    TrunkLink,
    Primary,
    PrimaryLink,
    Secondary,
    SecondaryLink,
    Tertiary,
    TertiaryLink,
    Unclassified,
    Residential,
    LivingStreet,
    Service,
    Road,
    Busway,
    #[serde(other)]
    Unknown,
}

impl RoadClass {
    /// The package key of the class (`motorway`, `living_street`, …).
    pub fn key(self) -> &'static str {
        match self {
            Self::Motorway => "motorway",
            Self::MotorwayLink => "motorway_link",
            Self::Trunk => "trunk",
            Self::TrunkLink => "trunk_link",
            Self::Primary => "primary",
            Self::PrimaryLink => "primary_link",
            Self::Secondary => "secondary",
            Self::SecondaryLink => "secondary_link",
            Self::Tertiary => "tertiary",
            Self::TertiaryLink => "tertiary_link",
            Self::Unclassified => "unclassified",
            Self::Residential => "residential",
            Self::LivingStreet => "living_street",
            Self::Service => "service",
            Self::Road => "road",
            Self::Busway => "busway",
            Self::Unknown => "unknown",
        }
    }

    /// Roads on which the keep-right rule applies to lane changes (MOBIL bias).
    pub fn keep_right(self) -> bool {
        matches!(
            self,
            Self::Motorway | Self::MotorwayLink | Self::Trunk | Self::TrunkLink
        )
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default = "default_road_class")]
    pub road_class: RoadClass,
    #[serde(default)]
    pub layer: i32,
    #[serde(default)]
    pub roundabout: bool,
    #[serde(default = "default_true")]
    pub through_traffic: bool,
    pub length: f64,
    pub speed_limit: f64,
    #[serde(default)]
    pub geometry: Vec<Point>,
    pub lanes: Vec<Lane>,
    #[serde(default)]
    pub boundaries: Vec<Boundary>,
    #[serde(default)]
    pub no_lane_change_zone: f64,
}

fn default_road_class() -> RoadClass {
    RoadClass::Unknown
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VehicleClassDto {
    Car,
    Van,
    Truck,
    Bus,
    Motorcycle,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    pub index: u32,
    #[serde(default = "default_lane_width")]
    pub width: f64,
    pub speed_limit: f64,
    pub allowed: Vec<VehicleClassDto>,
    pub geometry: Vec<Point>,
    pub length: f64,
}

fn default_lane_width() -> f64 {
    3.25
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Boundary {
    pub right_lane: u32,
    pub left_lane: u32,
    pub allow_left: bool,
    pub allow_right: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Turn {
    Through,
    Left,
    Right,
    SlightLeft,
    SlightRight,
    SharpLeft,
    SharpRight,
    Reverse,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Major,
    Minor,
    Stop,
    Signal,
    RightBeforeLeft,
    RoundaboutEntry,
    RoundaboutRing,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub node: String,
    pub from_link: String,
    pub from_lane: u32,
    pub to_link: String,
    pub to_lane: u32,
    #[serde(default = "default_turn")]
    pub turn: Turn,
    pub priority: Priority,
    #[serde(default)]
    pub signal_group: Option<String>,
    #[serde(default)]
    pub geometry: Vec<Point>,
    pub length: f64,
    #[serde(default)]
    pub conflicts: Vec<String>,
}

fn default_turn() -> Turn {
    Turn::Unknown
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SignalController {
    pub node: String,
    pub cycle: f64,
    #[serde(default)]
    pub offset: f64,
    pub groups: Vec<SignalGroup>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SignalGroup {
    pub id: String,
    pub green: Vec<[f64; 2]>,
    #[serde(default)]
    pub amber: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrossingKind {
    Zebra,
    Signal,
    Uncontrolled,
    Unmarked,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrossingSignalMode {
    Parallel,
    Request,
    #[serde(other)]
    Unknown,
}

/// A directional link crossed by a pedestrian crossing.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossingLink {
    pub link: String,
    pub position: f64,
    pub span: [f64; 2],
}

/// A pedestrian crossing (ADR-0020).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crossing {
    pub id: String,
    pub kind: CrossingKind,
    #[serde(default)]
    pub signal_group: Option<String>,
    #[serde(default)]
    pub signal_mode: Option<CrossingSignalMode>,
    pub width: f64,
    #[serde(default = "default_crossing_depth")]
    pub depth: f64,
    #[serde(default)]
    pub demand: f64,
    #[serde(default)]
    pub geometry: Vec<Point>,
    pub links: Vec<CrossingLink>,
}

fn default_crossing_depth() -> f64 {
    3.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synth::FIXTURE;

    #[test]
    fn parses_the_golden_fixture() {
        let p = Package::from_json(FIXTURE).unwrap();
        assert_eq!(p.format_version, 1);
        assert_eq!(p.nodes.len(), 9);
        assert_eq!(p.links.len(), 10);
        assert_eq!(p.connectors.len(), 14);
        assert_eq!(p.signals.len(), 1);
        assert_eq!(p.signals[0].groups.len(), 2);
        let l3 = p.links.iter().find(|l| l.id == "l3").unwrap();
        assert!(l3.boundaries[0].allow_left && !l3.boundaries[0].allow_right);
        assert_eq!(l3.no_lane_change_zone, 30.0);
        let l9 = p.links.iter().find(|l| l.id == "l9").unwrap();
        assert_eq!(l9.road_class, RoadClass::Motorway);
        assert_eq!(l9.layer, 1);
        assert!(l9.road_class.keep_right());
        let c3 = p.connectors.iter().find(|c| c.id == "c3").unwrap();
        assert_eq!(c3.priority, Priority::Signal);
        assert_eq!(c3.turn, Turn::Left);
        assert_eq!(c3.signal_group.as_deref(), Some("n0:g0"));
    }

    #[test]
    fn ignores_unknown_keys_and_unknown_enum_values() {
        let json = r#"{
            "formatVersion": 1, "futureKey": {"a": [1, 2]},
            "nodes": [{"id": "a", "x": 0, "y": 0, "z": 0, "control": "teleporter", "extra": true}],
            "links": [], "connectors": [], "signals": []
        }"#;
        let p = Package::from_json(json).unwrap();
        assert_eq!(p.nodes[0].control, NodeControl::Unknown);
    }

    #[test]
    fn reports_syntax_and_type_errors() {
        assert!(
            Package::from_json("{")
                .unwrap_err()
                .contains("invalid network package")
        );
        assert!(Package::from_json(r#"{"formatVersion": "one"}"#).is_err());
    }

    #[test]
    fn optional_fields_have_defaults() {
        let json = r#"{"formatVersion": 1,
            "links": [{"id": "l", "from": "a", "to": "b", "length": 10, "speedLimit": 10,
              "lanes": [{"index": 0, "speedLimit": 10, "allowed": ["car", "hovercraft"],
                         "geometry": [[0,0,0],[10,0,0]], "length": 10}]}],
            "connectors": [{"id": "c", "node": "b", "fromLink": "l", "fromLane": 0, "toLink": "l",
              "toLane": 0, "priority": "major", "length": 1}]}"#;
        let p = Package::from_json(json).unwrap();
        let l = &p.links[0];
        assert!(l.through_traffic);
        assert_eq!(l.road_class, RoadClass::Unknown);
        assert_eq!(l.lanes[0].width, 3.25);
        assert_eq!(
            l.lanes[0].allowed,
            vec![VehicleClassDto::Car, VehicleClassDto::Unknown]
        );
        assert_eq!(p.connectors[0].turn, Turn::Unknown);
        assert!(p.connectors[0].signal_group.is_none());
        assert!(p.signals.is_empty() && p.nodes.is_empty());
        assert!(p.crossings.is_none());
    }

    #[test]
    fn parses_crossings() {
        let json = r#"{"formatVersion": 1, "crossings": [
            {"id": "x0", "osmId": 5, "kind": "signal", "node": "n1", "signalGroup": "n1:g0",
             "signalMode": "request", "implicit": false, "width": 7, "depth": 4, "demand": 120,
             "geometry": [[0, -3.5, 0], [0, 3.5, 0]],
             "links": [{"link": "l0", "position": 100, "span": [0, 3.5]}]},
            {"id": "x1", "kind": "teleporter", "width": 3, "links": [], "signalMode": "magic"}]}"#;
        let p = Package::from_json(json).unwrap();
        let x = p.crossings.unwrap();
        assert_eq!(x[0].kind, CrossingKind::Signal);
        assert_eq!(x[0].signal_mode, Some(CrossingSignalMode::Request));
        assert_eq!(x[0].links[0].span, [0.0, 3.5]);
        assert_eq!(
            (x[1].kind, x[1].depth, x[1].demand),
            (CrossingKind::Unknown, 3.0, 0.0)
        );
        assert_eq!(x[1].signal_mode, Some(CrossingSignalMode::Unknown));
        let null = Package::from_json(r#"{"formatVersion": 1, "crossings": null}"#).unwrap();
        assert!(null.crossings.is_none());
    }
}
