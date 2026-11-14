/**
 * Space-time diagram helper: bins vehicle speeds along the road into fixed cells. One column
 * per frame, stacked over time, shows stop-and-go waves as stripes travelling upstream — the
 * first, one-lane version of the heatmaps of Phase 6.
 */

import type { VehicleState } from '../sim/protocol';

/** Returns the speed ratio per cell, or NaN for empty cells. */
export function binSpeedRatios(vehicles: VehicleState[], length: number, cells: number, desiredSpeed: number): Float32Array {
  const sums = new Float32Array(cells);
  const counts = new Uint16Array(cells);
  for (const { position, speed } of vehicles) {
    const wrapped = ((position % length) + length) % length;
    const cell = Math.min(cells - 1, Math.floor((wrapped / length) * cells));
    sums[cell]! += speed;
    counts[cell]! += 1;
  }
  const ratios = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    ratios[i] = counts[i]! === 0 ? Number.NaN : sums[i]! / counts[i]! / desiredSpeed;
  }
  return ratios;
}
