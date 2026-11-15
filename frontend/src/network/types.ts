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
  /** Vehicle dimension limits (#125): metres and tonnes, absent when unrestricted. */
  limits?: { maxLength?: number; maxWidth?: number; maxHeight?: number; maxWeight?: number };
  /** OSM nodes next to `from`/`to` along the way; with the node `osmId` they key a movement for edits (ADR-0010). */
  osmAfterFrom?: number | null;
  osmBeforeTo?: number | null;
  /** Link runs in OSM way node order (package field since v1.1 of the spec; absent in older packages). */
  osmForward?: boolean;
  /** Sign at the approach to `to` (#104); absent in older packages. */
  endSign?: EndSign;
  /** OSM nodes along the link in travel direction, untrimmed (#105); absent in older packages. */
  osmNodes?: readonly OsmNodeRef[];
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
  /** Import polygon `[lon, lat][]` for non-rectangular imports (#110). */
  area?: readonly (readonly [number, number])[];
  /** Terrain height grid (#87, ADR-0018); absent for flat networks. */
  terrain?: TerrainGrid;
  osmTimestamp: string | null;
  attribution: string[];
  nodes: NetworkNode[];
  links: Link[];
  connectors: Connector[];
  signals: SignalController[];
  stats: PackageStats;
  /** Pedestrian crossings (ADR-0020, #86); absent in older packages. */
  crossings?: Crossing[];
  /** Public transport lines (#85); absent when the area has none. */
  transitLines?: TransitLine[];
}

/** A stop of a transit line (#85). */
export interface TransitStop {
  id: string;
  osmId: number | null;
  name: string | null;
  /** Link of the line the stop lies on and the distance along it (m). */
  link: string;
  pos: number;
  /** The bus pulls into a bay instead of blocking the kerb lane. */
  bay: boolean;
}

/** One direction of a bus line mapped onto the links (#85, ADR-0019). */
export interface TransitLine {
  id: string;
  osmId: number | null;
  ref: string | null;
  name: string | null;
  mode: string;
  colour: string | null;
  /** Headway (s) from OSM `interval`; null when not mapped. */
  headway: number | null;
  links: string[];
  stops: TransitStop[];
}

export const CROSSING_KINDS = ['zebra', 'signal', 'uncontrolled', 'unmarked'] as const;
export type CrossingKind = (typeof CROSSING_KINDS)[number];

export const CROSSING_SIGNAL_MODES = ['parallel', 'request'] as const;
export type CrossingSignalMode = (typeof CROSSING_SIGNAL_MODES)[number];

/** A directional link crossed by a crossing: centre position along the link, lane span along the crossing. */
export interface CrossingLink {
  link: string;
  position: number;
  span: readonly [number, number];
}

/** A pedestrian crossing (docs/architecture/network-package.md "Crossing"). */
export interface Crossing {
  id: string;
  osmId: number | null;
  kind: CrossingKind;
  node: string | null;
  signalGroup: string | null;
  signalMode: CrossingSignalMode | null;
  implicit: boolean;
  /** Kerb-to-kerb walking distance (m). */
  width: number;
  /** Extent along the road (m). */
  depth: number;
  /** Estimated pedestrians per hour. */
  demand: number;
  /** First kerb → second kerb. */
  geometry: readonly [Vec3, Vec3];
  links: CrossingLink[];
}

export const END_SIGNS = ['none', 'stop', 'give_way', 'priority_road'] as const;
export type EndSign = (typeof END_SIGNS)[number];

/** An OSM node along a link (null id for clip points at the area border). */
export interface OsmNodeRef {
  id: number | null;
  x: number;
  y: number;
}

/**
 * Regular terrain grid in the local plane (ADR-0018): heights in metres relative to the ground at the
 * origin (the same datum as geometry `z`), row-major from the south-west corner.
 */
export interface TerrainGrid {
  /** East coordinate of the first column (m). */
  west: number;
  /** North coordinate of the first row (m). */
  south: number;
  cellSize: number;
  columns: number;
  rows: number;
  heights: readonly number[];
  /** Ground height of the origin above sea level (m). */
  originElevation: number;
}
