// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PackageIndex } from '../network/inspect';
import { editorNetwork } from '../test/editorNetwork';
import { carrySelection, selectedLink, selectedNodeId } from './selection';
import { drawShortcut, historyShortcut, isTextInput } from './shortcuts';

const before = new PackageIndex(editorNetwork());

/** The same network compiled again with shifted ids (as after an edit). */
function recompiled(): PackageIndex {
  const pkg = editorNetwork();
  const rename = (id: string) => id.replace(/^([nlc])(\d+)/, (_, p: string, n: string) => `${p}${Number(n) + 10}`);
  pkg.nodes = pkg.nodes.map((n) => ({ ...n, id: rename(n.id) }));
  pkg.links = pkg.links.map((l) => ({ ...l, id: rename(l.id), from: rename(l.from), to: rename(l.to), oppositeLink: l.oppositeLink && rename(l.oppositeLink) }));
  pkg.links[0]!.lanes = pkg.links[0]!.lanes.slice(0, 1);
  pkg.connectors = [];
  return new PackageIndex(pkg);
}

describe('selection across recompiles', () => {
  const after = recompiled();

  it('follows nodes, links and lanes by OSM ids', () => {
    expect(carrySelection(before, after, { kind: 'node', nodeId: 'n0' })).toEqual({ kind: 'node', nodeId: 'n10' });
    expect(carrySelection(before, after, { kind: 'link', linkId: 'l1' })).toEqual({ kind: 'link', linkId: 'l11' });
    expect(carrySelection(before, after, { kind: 'lane', linkId: 'l0', laneIndex: 1 })).toEqual({ kind: 'lane', linkId: 'l10', laneIndex: 0 });
    expect(carrySelection(before, after, { kind: 'connector', connectorId: 'c3' })).toEqual({ kind: 'node', nodeId: 'n10' });
  });

  it('drops selections that no longer exist', () => {
    expect(carrySelection(before, after, null)).toBeNull();
    expect(carrySelection(before, after, { kind: 'link', linkId: 'nope' })).toBeNull();
    expect(carrySelection(before, after, { kind: 'connector', connectorId: 'nope' })).toBeNull();
    const gone = new PackageIndex({ ...editorNetwork(), links: [], connectors: [] });
    expect(carrySelection(before, gone, { kind: 'lane', linkId: 'l0', laneIndex: 0 })).toBeNull();
    const pkg = editorNetwork();
    pkg.nodes[0]!.osmId = null;
    expect(carrySelection(new PackageIndex(pkg), after, { kind: 'link', linkId: 'l0' })).toBeNull();
  });

  it('resolves the selected link or junction', () => {
    expect(selectedLink(before, { kind: 'lane', linkId: 'l2', laneIndex: 0 })?.id).toBe('l2');
    expect(selectedLink(before, { kind: 'node', nodeId: 'n0' })).toBeNull();
    expect(selectedNodeId(before, { kind: 'connector', connectorId: 'c1' })).toBe('n0');
    expect(selectedNodeId(before, { kind: 'node', nodeId: 'n0' })).toBe('n0');
    expect(selectedNodeId(before, { kind: 'node', nodeId: 'x' })).toBeNull();
    expect(selectedNodeId(before, null)).toBeNull();
  });
});

describe('editor shortcuts (#70)', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it('maps undo and redo', () => {
    expect(historyShortcut(key('z', { ctrlKey: true }))).toBe('undo');
    expect(historyShortcut(key('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(historyShortcut(key('z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(historyShortcut(key('y', { ctrlKey: true }))).toBe('redo');
    expect(historyShortcut(key('z'))).toBeNull();
    expect(historyShortcut(key('z', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(historyShortcut(key('x', { ctrlKey: true }))).toBeNull();
  });

  it('maps drawing keys', () => {
    expect(drawShortcut(key('Enter'))).toBe('finish');
    expect(drawShortcut(key('Escape'))).toBe('cancel');
    expect(drawShortcut(key('Backspace'))).toBe('back');
    expect(drawShortcut(key('Enter', { ctrlKey: true }))).toBeNull();
    expect(drawShortcut(key('a'))).toBeNull();
  });

  it('recognises text inputs', () => {
    const input = document.createElement('input');
    expect(isTextInput(input)).toBe(true);
    input.type = 'checkbox';
    expect(isTextInput(input)).toBe(false);
    expect(isTextInput(document.createElement('textarea'))).toBe(true);
    expect(isTextInput(document.createElement('div'))).toBe(false);
    expect(isTextInput(null)).toBe(false);
  });
});
