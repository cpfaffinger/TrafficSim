import { cumulativeLengths, offsetPolyline, stationAt } from '../network/polyline';
import type { NetworkPackage } from '../network/types';
import type { LaneRow } from './laneCells';

/**
 * Geometry of the heatmap lane ribbons (#59): one quad per lane cell along the lane centreline,
 * `widthFactor` of the lane width wide, lifted slightly above the road surface. Positions are ENU
 * (`[east, north, up]`), 4 vertices per cell in cell order so colours can be written per cell.
 */
export interface CellRibbons {
  positions: Float32Array;
  indices: Uint32Array;
  cellCount: number;
}

export function buildCellRibbons(pkg: NetworkPackage, lanes: readonly LaneRow[], cellCount: number, cellLength: number, widthFactor = 0.7, lift = 0.06): CellRibbons {
  const positions = new Float32Array(cellCount * 4 * 3);
  const indices = new Uint32Array(cellCount * 6);
  for (const row of lanes) {
    const link = pkg.links[row.linkIndex];
    const lane = link?.lanes.find((l) => l.index === row.laneIndex);
    if (!link || !lane || lane.geometry.length < 2) continue;
    const half = (lane.width * widthFactor) / 2;
    const left = offsetPolyline(lane.geometry, -half);
    const right = offsetPolyline(lane.geometry, half);
    const cumLeft = cumulativeLengths(left);
    const cumRight = cumulativeLengths(right);
    const cumCentre = cumulativeLengths(lane.geometry);
    const total = cumCentre[cumCentre.length - 1]!;
    // Cells are defined on the sim's lane length; map them proportionally onto the drawn centreline.
    const scale = row.length > 0 ? total / row.length : 1;
    for (let i = 0; i < row.cellCount; i++) {
      const cell = row.firstCell + i;
      if (cell >= cellCount) break;
      const s0 = Math.min(total, i * cellLength * scale);
      const s1 = Math.min(total, Math.min(row.length, (i + 1) * cellLength) * scale);
      const at = (line: typeof left, cum: number[], s: number) => stationAt(line, (s / total) * cum[cum.length - 1]!, cum).point;
      const corners = [at(left, cumLeft, s0), at(right, cumRight, s0), at(right, cumRight, s1), at(left, cumLeft, s1)];
      corners.forEach((p, v) => {
        const o = (cell * 4 + v) * 3;
        positions[o] = p[0];
        positions[o + 1] = p[1];
        positions[o + 2] = p[2] + lift;
      });
      const base = cell * 4;
      indices.set([base, base + 1, base + 2, base, base + 2, base + 3], cell * 6);
    }
  }
  return { positions, indices, cellCount };
}
