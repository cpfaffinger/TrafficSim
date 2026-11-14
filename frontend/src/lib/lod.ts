/**
 * Level of detail by camera distance (#80). Thresholds are in metres of camera-to-target distance.
 * Far away, thin details (markings, arrows) alias and buildings dominate fill rate, while vehicles
 * would shrink below a pixel — so details are hidden and vehicles are drawn enlarged.
 */
export interface LodState {
  markings: boolean;
  buildings: boolean;
  /** Multiplier for vehicle width/height (length stays true to scale up to 2×). */
  vehicleScale: number;
}

export const LOD_THRESHOLDS = { markings: 1800, buildings: 4500, vehicleEnlargeFrom: 600 } as const;

export function lodFor(distance: number): LodState {
  const d = Math.max(0, distance);
  const enlarge = d <= LOD_THRESHOLDS.vehicleEnlargeFrom ? 1 : Math.min(6, d / LOD_THRESHOLDS.vehicleEnlargeFrom);
  return {
    markings: d < LOD_THRESHOLDS.markings,
    buildings: d < LOD_THRESHOLDS.buildings,
    vehicleScale: enlarge,
  };
}

export function sameLod(a: LodState, b: LodState): boolean {
  return a.markings === b.markings && a.buildings === b.buildings && Math.abs(a.vehicleScale - b.vehicleScale) < 0.05;
}
