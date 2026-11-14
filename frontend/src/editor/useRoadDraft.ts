import { useCallback, useState } from 'react';
import type { PackageIndex } from '../network/inspect';
import { addDraftPoint, buildRoad, DEFAULT_ROAD, snapPoint, type DraftPoint, type RoadSpec } from './drawRoad';
import type { Changeset, EditResult } from './ops';

export interface RoadDraft {
  points: DraftPoint[];
  spec: RoadSpec;
  setSpec: (spec: RoadSpec) => void;
  /** Adds a clicked ground point (ENU metres), snapped against the displayed network. */
  add: (index: PackageIndex, enu: readonly [number, number]) => void;
  back: () => void;
  cancel: () => void;
  /** The edit for the drawn road; the draft is cleared once it was applied. */
  finish: (index: PackageIndex, changeset: Changeset, apply: (build: () => EditResult) => boolean) => boolean;
}

/** State of the "draw road" tool (#69). */
export function useRoadDraft(): RoadDraft {
  const [points, setPoints] = useState<DraftPoint[]>([]);
  const [spec, setSpec] = useState<RoadSpec>(DEFAULT_ROAD);

  const add = useCallback((index: PackageIndex, enu: readonly [number, number]) => setPoints((p) => addDraftPoint(p, snapPoint(index, enu))), []);
  const back = useCallback(() => setPoints((p) => p.slice(0, -1)), []);
  const cancel = useCallback(() => setPoints([]), []);
  const finish = useCallback(
    (index: PackageIndex, changeset: Changeset, apply: (build: () => EditResult) => boolean) => {
      const ok = apply(() => buildRoad(index, points, spec, changeset));
      if (ok) setPoints([]);
      return ok;
    },
    [points, spec],
  );

  return { points, spec, setSpec, add, back, cancel, finish };
}
