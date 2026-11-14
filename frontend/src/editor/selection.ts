import type { PackageIndex } from '../network/inspect';
import type { PickTarget } from '../network/meshData';
import type { Link } from '../network/types';

/**
 * Keeps the selection across recompiled packages. Compiled ids (`n…`, `l…`, `c…`) change after an
 * edit; OSM ids do not, so links are matched by their OSM way and end nodes, nodes by `osmId`.
 */
function linkKey(index: PackageIndex, link: Link): string | null {
  const a = index.nodes.get(link.from)?.osmId;
  const b = index.nodes.get(link.to)?.osmId;
  return a == null || b == null ? null : `${a}>${b}`;
}

function findLink(from: PackageIndex, to: PackageIndex, linkId: string): Link | null {
  const old = from.links.get(linkId);
  if (!old) return null;
  const key = linkKey(from, old);
  if (key === null) return null;
  const candidates = to.pkg.links.filter((l) => linkKey(to, l) === key);
  return candidates.find((l) => l.osmWayId === old.osmWayId) ?? candidates[0] ?? null;
}

export function carrySelection(from: PackageIndex, to: PackageIndex, target: PickTarget | null): PickTarget | null {
  if (!target) return null;
  switch (target.kind) {
    case 'node': {
      const osmId = from.nodes.get(target.nodeId)?.osmId;
      const node = osmId == null ? undefined : to.pkg.nodes.find((n) => n.osmId === osmId);
      return node ? { kind: 'node', nodeId: node.id } : null;
    }
    case 'link': {
      const link = findLink(from, to, target.linkId);
      return link ? { kind: 'link', linkId: link.id } : null;
    }
    case 'lane': {
      const link = findLink(from, to, target.linkId);
      return link ? { kind: 'lane', linkId: link.id, laneIndex: Math.min(target.laneIndex, link.lanes.length - 1) } : null;
    }
    case 'connector': {
      const c = from.connectors.get(target.connectorId);
      return c ? carrySelection(from, to, { kind: 'node', nodeId: c.node }) : null;
    }
  }
}

/** The link a target refers to (lanes select their link). */
export function selectedLink(index: PackageIndex, target: PickTarget | null): Link | null {
  if (target?.kind === 'link' || target?.kind === 'lane') return index.links.get(target.linkId) ?? null;
  return null;
}

/** The junction a target refers to (movements select their junction). */
export function selectedNodeId(index: PackageIndex, target: PickTarget | null): string | null {
  if (target?.kind === 'node') return index.nodes.has(target.nodeId) ? target.nodeId : null;
  if (target?.kind === 'connector') return index.connectors.get(target.connectorId)?.node ?? null;
  return null;
}
