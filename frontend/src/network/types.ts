/**
 * Network package format v1 (docs/architecture/network-package.md). Coordinates are metres in the
 * local East-North-Up plane around `origin`: `[east, north, up]`.
 */

export type Vec3 = readonly [number, number, number];
export type Polyline = readonly Vec3[];
export type BBox = readonly [west: number, south: number, east: number, north: number];

export const NODE_CONTROLS = [
  'none',
  'priority',
  'right_before_left',
  'all_way_stop',
  'signal',
  'roundabout',
  'level_crossing',
  'boundary',
] as const;
export type NodeControl = (typeof NODE_CONTROLS)[number];

export const ROAD_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'road',
  'busway',
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

export const STRUCTURES = ['none', 'bridge', 'tunnel', 'covered'] as const;
export type Structure = (typeof STRUCTURES)[number];

export const VEHICLE_CLASSES = ['car', 'van', 'truck', 'bus', 'motorcycle'] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const LANE_TURNS = [
  'left',
  'slight_left',
  'sharp_left',
  'through',
  'right',
  'slight_right',
  'sharp_right',
  'reverse',
  'merge_to_left',
  'merge_to_right',
] as const;
export type LaneTurn = (typeof LANE_TURNS)[number];

export const BOUNDARY_MARKINGS = ['dashed', 'solid', 'double_solid', 'solid_dashed', 'dashed_solid'] as const;
export type BoundaryMarking = (typeof BOUNDARY_MARKINGS)[number];

export const LEFT_EDGES = ['centre_dashed', 'centre_solid', 'double_solid', 'edge'] as const;
export type LeftEdge = (typeof LEFT_EDGES)[number];

export const CONNECTOR_TURNS = [
  'through',
  'left',
  'right',
  'slight_left',
  'slight_right',
  'sharp_left',
  'sharp_right',
  'reverse',
] as const;
export type ConnectorTurn = (typeof CONNECTOR_TURNS)[number];

export const PRIORITIES = [
  'major',
  'minor',
  'stop',
  'signal',
  'right_before_left',
  'roundabout_entry',
  'roundabout_ring',
] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface GeoOrigin {
  lat: number;
  lon: number;
}

export interface NetworkNode {
  id: string;
  osmId: number | null;
  x: number;
  y: number;
  z: number;
  control: NodeControl;
}

export interface Lane {
  id: string;
  index: number;
  width: number;
  speedLimit: number;
  allowed: VehicleClass[];
  turns: LaneTurn[];
  geometry: Polyline;
  length: number;
}

export interface Boundary {
  rightLane: number;
  leftLane: number;
  marking: BoundaryMarking;
  allowLeft: boolean;
  allowRight: boolean;
}

export interface Link {
  id: string;
  osmWayId: number | null;
  from: string;
  to: string;
  roadClass: RoadClass;
  name: string | null;
  layer: number;
  structure: Structure;
  roundabout: boolean;
  oppositeLink: string | null;
  throughTraffic: boolean;
  length: number;
  speedLimit: number;
  geometry: Polyline;
  lanes: Lane[];
  boundaries: Boundary[];
  leftEdge: LeftEdge;
  noLaneChangeZone: number;
  assumed: string[];
}

export interface Connector {
  id: string;
  node: string;
  fromLink: string;
  fromLane: number;
  toLink: string;
  toLane: number;
  turn: ConnectorTurn;
  priority: Priority;
  signalGroup: string | null;
  geometry: Polyline;
  length: number;
  conflicts: string[];
}

export interface SignalGroup {
  id: string;
  green: [number, number][];
  amber: number;
}

export interface SignalController {
  node: string;
  cycle: number;
  offset: number;
  groups: SignalGroup[];
}

export interface PackageStats {
  nodes: number;
  links: number;
  lanes: number;
  connectors: number;
  signals: number;
}

export interface NetworkPackage {
  formatVersion: 1;
  baselineId: string | null;
  origin: GeoOrigin;
  bbox: BBox;
  osmTimestamp: string | null;
  attribution: string[];
  nodes: NetworkNode[];
  links: Link[];
  connectors: Connector[];
  signals: SignalController[];
  stats: PackageStats;
}
