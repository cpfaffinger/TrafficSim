/**
 * Built-in catalogues of the sim core (vehicle types, driver profiles, road-class demand profiles).
 * The authoritative source are the WASM free functions `builtinVehicleTypesJson`,
 * `builtinDriverProfilesJson` and `builtinRoadClassProfilesJson`; `FALLBACK_BUILTINS` mirrors them
 * (sim-core/README.md tables, checked by a test) for the moment before the module has loaded.
 */

export interface RoadClassProfile {
  volumePerLane: number;
  curve: string;
}

export interface Builtins {
  vehicleTypes: string[];
  driverProfiles: string[];
  /** By road-class key, including `unknown`. */
  roadClassProfiles: Record<string, RoadClassProfile>;
}

const weekday = (volumePerLane: number): RoadClassProfile => ({ volumePerLane, curve: 'weekday' });

/** Road-class keys in sim-core profile order (`ROAD_CLASSES` in sim-core/src/demand.rs). */
export const PROFILE_CLASSES = [
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
  'unknown',
] as const;

export const FALLBACK_BUILTINS: Builtins = {
  vehicleTypes: ['car', 'van', 'truck', 'articulatedTruck', 'bus', 'motorcycle'],
  driverProfiles: ['average', 'attentive', 'aggressive', 'distracted', 'commuter'],
  roadClassProfiles: {
    motorway: weekday(1400),
    motorway_link: weekday(600),
    trunk: weekday(1000),
    trunk_link: weekday(400),
    primary: weekday(600),
    primary_link: weekday(300),
    secondary: weekday(400),
    secondary_link: weekday(200),
    tertiary: weekday(250),
    tertiary_link: weekday(150),
    unclassified: weekday(120),
    residential: weekday(60),
    living_street: weekday(20),
    service: weekday(30),
    road: weekday(150),
    busway: weekday(30),
    unknown: weekday(150),
  },
};

const keysOf = (json: string): string[] => {
  const v = JSON.parse(json) as unknown;
  return typeof v === 'object' && v !== null ? Object.keys(v) : [];
};

/** Builds the catalogue from the WASM JSON strings; names keep the fallback order where known. */
export function parseBuiltins(vehicleTypesJson: string, driverProfilesJson: string, roadClassProfilesJson: string): Builtins {
  const order = (names: string[], preferred: readonly string[]) => [
    ...preferred.filter((n) => names.includes(n)),
    ...names.filter((n) => !preferred.includes(n)).sort(),
  ];
  const profiles = JSON.parse(roadClassProfilesJson) as Record<string, { volumePerLane: number; curve: string }>;
  const classes = order(Object.keys(profiles), PROFILE_CLASSES);
  return {
    vehicleTypes: order(keysOf(vehicleTypesJson), FALLBACK_BUILTINS.vehicleTypes),
    driverProfiles: order(keysOf(driverProfilesJson), FALLBACK_BUILTINS.driverProfiles),
    roadClassProfiles: Object.fromEntries(classes.map((c) => [c, { volumePerLane: profiles[c]!.volumePerLane, curve: profiles[c]!.curve }])),
  };
}

/** Profile of a road class as the sim core resolves it (unknown keys use `unknown`). */
export function profileOf(builtins: Builtins, roadClass: string): RoadClassProfile {
  return builtins.roadClassProfiles[roadClass] ?? builtins.roadClassProfiles.unknown ?? weekday(150);
}
