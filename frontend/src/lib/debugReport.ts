import type { PackageIndex } from '../network/inspect';
import type { PickTarget } from '../network/meshData';
import type { DebugKind } from '../sim/networkProtocol';

/** What a debug download is about (#129). */
export interface DebugSelection {
  kind: DebugKind;
  id: string;
  /** Lane index for `lane`, else -1. */
  lane: number;
}

/** The debug request for the selected vehicle or network element; connectors report their junction. */
export function debugSelection(vehicleId: number | null, target: PickTarget | null, index: PackageIndex | null): DebugSelection | null {
  if (vehicleId !== null) return { kind: 'vehicle', id: String(vehicleId), lane: -1 };
  if (!target) return null;
  switch (target.kind) {
    case 'lane':
      return { kind: 'lane', id: target.linkId, lane: target.laneIndex };
    case 'link':
      return { kind: 'link', id: target.linkId, lane: -1 };
    case 'node':
      return { kind: 'node', id: target.nodeId, lane: -1 };
    case 'connector': {
      const node = index?.connectors.get(target.connectorId)?.node;
      return node ? { kind: 'node', id: node, lane: -1 } : null;
    }
  }
}

/** The package data of the selection: the link (with its opposite), or the junction with its movements and signal plan. */
export function packageExcerpt(selection: DebugSelection, index: PackageIndex | null): unknown {
  if (!index) return null;
  if (selection.kind === 'link' || selection.kind === 'lane') {
    const link = index.links.get(selection.id);
    const opposite = link?.oppositeLink ? index.links.get(link.oppositeLink) : undefined;
    return { link, opposite: opposite ?? null };
  }
  if (selection.kind === 'node') {
    const connectors = [...index.connectors.values()].filter((c) => c.node === selection.id);
    const links = [...index.links.values()].filter((l) => l.from === selection.id || l.to === selection.id).map((l) => ({ ...l, geometry: undefined, osmNodes: undefined }));
    return { node: index.nodes.get(selection.id), links, connectors, signal: index.signals.get(selection.id) ?? null };
  }
  return null;
}

export interface DebugContext {
  build: string;
  baselineId: string | null;
  scenario: { id: string; name: string } | null;
  settings: unknown;
}

/** The downloadable report: context, the simulation's snapshot and the package excerpt. */
export function debugReport(selection: DebugSelection, simulationJson: string, context: DebugContext, index: PackageIndex | null) {
  return {
    format: 'trafficsim-debug-v1',
    createdAt: new Date().toISOString(),
    ...context,
    selection,
    simulation: JSON.parse(simulationJson) as unknown,
    package: packageExcerpt(selection, index),
  };
}

export function debugFileName(selection: DebugSelection, time: number): string {
  const lane = selection.kind === 'lane' ? `-${selection.lane}` : '';
  return `trafficsim-debug-${selection.kind}-${selection.id}${lane}-t${Math.round(time)}.json`;
}

/** Saves text as a file in the browser. */
export function downloadText(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
