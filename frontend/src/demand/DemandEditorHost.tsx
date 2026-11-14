import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { PickTarget } from '../network/meshData';
import type { NetworkPackage } from '../network/types';
import type { NetworkScene } from '../scene/NetworkScene';
import { FALLBACK_BUILTINS, type Builtins } from './builtins';
import { DemandEditor, type DemandHighlight, type DemandPick } from './DemandEditor';
import { DemandOverlay } from './DemandOverlay';
import { loadBuiltins as loadFromWasm } from './loadBuiltins';
import { parseDemand } from './model';
import { zoneShapes, type Point } from './zones';
import './demand.css';

export interface DemandEditorHostProps {
  scenario: { id: string; name: string; demand: unknown; durationSeconds: number };
  pkg: NetworkPackage;
  sceneRef: RefObject<Pick<NetworkScene, 'addOverlay' | 'removeOverlay' | 'invalidate'> | null>;
  /** Current map pick (selects zones / entry nodes). */
  target: PickTarget | null;
  readOnly: boolean;
  onSave?: (demand: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  loadBuiltins?: () => Promise<Builtins>;
}

/** Built-in catalogues from the sim-core WASM module (mirrored fallback until it has loaded). */
export function useBuiltins(load: () => Promise<Builtins> = loadFromWasm): Builtins {
  const [builtins, setBuiltins] = useState<Builtins>(FALLBACK_BUILTINS);
  useEffect(() => {
    let alive = true;
    load().then(
      (b) => alive && setBuiltins(b),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [load]);
  return builtins;
}

/** Map pick → link with its end nodes, or a node. */
export function demandPick(pkg: NetworkPackage, target: PickTarget | null): DemandPick | null {
  if (!target) return null;
  if (target.kind === 'node') return { nodeIds: [target.nodeId] };
  if (target.kind === 'connector') return null;
  const link = pkg.links.find((l) => l.id === target.linkId);
  return { linkId: target.linkId, nodeIds: link ? [link.from, link.to] : [] };
}

/** Glue between the demand editor, the WASM catalogues and the zone overlay in the 3D scene. */
export function DemandEditorHost({ scenario, pkg, sceneRef, target, readOnly, onSave, onClose, loadBuiltins }: DemandEditorHostProps) {
  const builtins = useBuiltins(loadBuiltins);
  const overlay = useRef<DemandOverlay | null>(null);
  const last = useRef<DemandHighlight>({ zone: null, from: null, to: null, nodes: [] });
  const shapes = useMemo(() => zoneShapes(parseDemand(scenario.demand).zones, pkg), [scenario.demand, pkg]);
  const nodes = useMemo(() => new Map<string, Point>(pkg.nodes.map((n) => [n.id, [n.x, n.y]])), [pkg]);
  const picked = useMemo(() => demandPick(pkg, target), [pkg, target]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const o = new DemandOverlay(scene);
    overlay.current = o;
    o.show(shapes, last.current, nodes);
    return () => {
      o.dispose();
      overlay.current = null;
    };
  }, [sceneRef, shapes, nodes]);

  const onHighlight = useCallback(
    (h: DemandHighlight) => {
      last.current = h;
      overlay.current?.show(shapes, h, nodes);
    },
    [shapes, nodes],
  );

  return (
    <DemandEditor
      key={scenario.id}
      scenario={scenario}
      pkg={pkg}
      builtins={builtins}
      readOnly={readOnly}
      picked={picked}
      onSave={onSave}
      onClose={onClose}
      onHighlight={onHighlight}
    />
  );
}
