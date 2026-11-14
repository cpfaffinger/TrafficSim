import { describe, expect, it } from 'vitest';
import { loadGoldenFixture } from '../test/goldenFixture';
import { boundaryLabel, inspect, kmh, PackageIndex, type InspectorModel } from './inspect';

const index = new PackageIndex(loadGoldenFixture());
const field = (m: InspectorModel | null, label: string) => m?.sections.flatMap((s) => s.fields).find((f) => f.label === label);

describe('inspector', () => {
  it('shows lane and road details for a picked lane', () => {
    const m = inspect(index, { kind: 'lane', linkId: 'l1', laneIndex: 1 });
    expect(m?.title).toBe('Lane l1:1');
    expect(field(m, 'Index')?.value).toBe('1 (leftmost of 2)');
    expect(field(m, 'Turns')?.value).toBe('left, through');
    expect(field(m, 'Allowed')?.value).toBe('car, van, truck, bus, motorcycle');
    expect(field(m, 'Width')).toEqual({ label: 'Width', value: '3.25 m', assumed: true });
    expect(field(m, 'Speed limit')?.value).toBe('50 km/h');
    expect(field(m, 'Name')?.value).toBe('Main Street');
    expect(field(m, 'Road class')?.value).toBe('primary');
    expect(field(m, 'Direction')?.value).toBe('two-way (opposite l4)');
    expect(field(m, 'No lane change zone')?.value).toBe('last 30.0 m');
    expect(field(m, 'End node control')?.value).toBe('signal');
    expect(field(m, 'Filled from defaults')?.value).toBe('width');
  });

  it('shows structure and markings for a bridge link', () => {
    const m = inspect(index, { kind: 'link', linkId: 'l9' });
    expect(field(m, 'Structure')?.value).toBe('bridge');
    expect(field(m, 'Layer')?.value).toBe('1');
    expect(field(m, 'Left edge')?.value).toBe('edge');
    expect(field(m, 'Direction')?.value).toBe('one-way');
    expect(field(m, 'Speed limit')?.value).toBe('100 km/h');
  });

  it('describes asymmetric lane boundaries', () => {
    expect(boundaryLabel(index.links.get('l3')!)).toBe('0|1: solid dashed (→left)');
    expect(boundaryLabel(index.links.get('l1')!)).toBe('0|1: dashed (→left →right)');
    expect(boundaryLabel(index.links.get('l5')!)).toBe('none (single lane)');
    const noChange = { ...index.links.get('l1')!, boundaries: [{ rightLane: 0, leftLane: 1, marking: 'solid' as const, allowLeft: false, allowRight: false }] };
    expect(boundaryLabel(noChange)).toBe('0|1: solid (no change)');
  });

  it('shows movements with priority, signal group and conflicts', () => {
    const c = index.pkg.connectors.find((x) => x.signalGroup === 'n0:g0' && x.conflicts.length > 0)!;
    const m = inspect(index, { kind: 'connector', connectorId: c.id });
    expect(field(m, 'Priority')?.value).toBe('signal');
    expect(field(m, 'Signal timing')?.value).toBe('green 0–40 s, amber 3 s (cycle 90 s)');
    expect(field(m, 'Conflicts')?.value).toContain(`${c.conflicts.length}:`);
    expect(field(m, 'Node')?.value).toBe('n0 (signal)');
  });

  it('shows the node control and signal plan', () => {
    const m = inspect(index, { kind: 'node', nodeId: 'n0' });
    expect(field(m, 'Control')?.value).toBe('signal');
    expect(field(m, 'Links in / out')?.value).toBe('4 / 4');
    expect(field(m, 'Cycle')?.value).toBe('90 s');
    expect(field(m, 'Group n0:g1')?.value).toBe('green 45–85 s, amber 3 s');
    expect(inspect(index, { kind: 'node', nodeId: 'n1' })?.sections).toHaveLength(1);
  });

  it('returns null for unknown targets', () => {
    expect(inspect(index, { kind: 'link', linkId: 'x' })).toBeNull();
    expect(inspect(index, { kind: 'lane', linkId: 'l1', laneIndex: 9 })).toBeNull();
    expect(inspect(index, { kind: 'connector', connectorId: 'x' })).toBeNull();
    expect(inspect(index, { kind: 'node', nodeId: 'x' })).toBeNull();
  });

  it('formats speeds', () => {
    expect(kmh(13.889)).toBe('50 km/h');
  });
});
