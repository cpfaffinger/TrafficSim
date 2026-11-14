// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackageIndex } from '../../network/inspect';
import { editorNetwork } from '../../test/editorNetwork';
import { createHistory, pushEdit } from '../history';
import type { EditOperation, EditResult, SetWayTagsOp } from '../ops';
import type { EditorSession } from '../useEditorSession';
import type { RoadDraft } from '../useRoadDraft';
import { DEFAULT_ROAD } from '../drawRoad';
import { DrawRoadPanel } from './DrawRoadPanel';
import { EditorPanel } from './EditorPanel';
import { EditorToolbar } from './EditorToolbar';
import { JunctionTools } from './JunctionTools';
import { LinkTools } from './LinkTools';

afterEach(cleanup);

const index = new PackageIndex(editorNetwork());
const signalised = new PackageIndex(editorNetwork({ signalised: true }));

function recorder() {
  const results: EditResult[] = [];
  const apply = vi.fn((build: () => EditResult) => {
    results.push(build());
    return true;
  });
  const lastTags = () => (results.at(-1)!.ops[0] as SetWayTagsOp).tags;
  return { results, apply, lastTags };
}

function session(over: Partial<EditorSession> = {}): EditorSession {
  return {
    baselineId: 'b1',
    scenario: null,
    history: createHistory(),
    changeset: [],
    dirty: false,
    preview: 'idle',
    issues: [],
    error: null,
    saving: false,
    startBaseline: vi.fn(),
    openScenario: vi.fn(),
    setScenario: vi.fn(),
    apply: vi.fn(() => true),
    replace: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    save: vi.fn(),
    clearError: vi.fn(),
    ...over,
  };
}

describe('EditorToolbar', () => {
  it('offers undo/redo with labels, save and tool modes', () => {
    const ban: EditOperation = { op: 'ban_movement', nodeId: 1, fromNeighbour: 2, toNeighbour: 3 };
    const s = session({ history: pushEdit(createHistory(), 'Ban left turn', [ban]), changeset: [ban], dirty: true, preview: 'loading' });
    const onMode = vi.fn();
    const onSave = vi.fn();
    render(<EditorToolbar session={s} mode="select" onMode={onMode} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo: Ban left turn' }));
    expect(s.undo).toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save as scenario' }));
    expect(onSave).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Draw road' }));
    expect(onMode).toHaveBeenCalledWith('draw');
    expect(screen.getByRole('status').textContent).toBe('1 edit · unsaved draft · Recompiling…');
  });

  it('shows errors and skipped edits', () => {
    const s = session({ error: 'Not saved: boom', issues: [{ operationIndex: 2, operation: 'X', message: 'way 9 not found' }] });
    render(<EditorToolbar session={s} mode="draw" onMode={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText(/Not saved: boom/)).toBeTruthy();
    expect(screen.getByText('1 edit was skipped:')).toBeTruthy();
    expect(screen.getByText('way 9 not found')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(s.clearError).toHaveBeenCalled();
  });
});

describe('LinkTools', () => {
  const renderTools = (linkId = 'l0', laneIndex: number | null = null) => {
    const r = recorder();
    render(<LinkTools index={index} link={index.links.get(linkId)!} laneIndex={laneIndex} changeset={[]} scope="way" apply={r.apply} />);
    return r;
  };

  it('adds, removes and re-marks lanes', () => {
    const r = renderTools();
    fireEvent.click(screen.getByRole('button', { name: '+ Lane on the left' }));
    expect(r.lastTags()['lanes:forward']).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: '+ Lane on the right' }));
    expect(r.lastTags()['turn:lanes:forward']).toBe('through|through;right|none');
    fireEvent.click(screen.getByRole('button', { name: 'Remove lane 1 (leftmost)' }));
    expect(r.lastTags()['lanes:forward']).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: /Marking between lane 1 and lane 0: dashed/ }));
    expect(r.lastTags()['change:lanes:forward']).toBe('not_right|not_left');
  });

  it('edits turn arrows and bus lanes per lane', () => {
    const r = renderTools();
    const lane1 = screen.getByRole('group', { name: 'Turn markings of lane 1 (leftmost)' });
    fireEvent.click(within(lane1).getByRole('button', { name: 'left' }));
    expect(r.lastTags()['turn:lanes:forward']).toBe('through;left|through;right');
    const lane0 = screen.getByRole('group', { name: 'Turn markings of lane 0 (rightmost)' });
    expect(within(lane0).getByRole('button', { name: 'right' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(lane0).getByRole('button', { name: 'right' }));
    expect(r.lastTags()['turn:lanes:forward']).toBe('through|through');
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Bus' })[1]!);
    expect(r.lastTags()['bus:lanes:forward']).toBe('yes|designated');
  });

  it('sets widths, one-way, direction split and centre line', () => {
    const r = renderTools('l0', 1);
    fireEvent.change(screen.getByLabelText('Lane width (m)'), { target: { value: '3.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set lane 1' }));
    expect(r.lastTags()['width:lanes:forward']).toBe('3.5|3');
    fireEvent.click(screen.getByRole('button', { name: 'Make one-way (this direction)' }));
    expect(r.lastTags().oneway).toBe('yes');
    fireEvent.click(screen.getByRole('button', { name: 'Move a lane to the other direction' }));
    expect(r.lastTags()['lanes:backward']).toBe('3');
    fireEvent.click(screen.getByRole('checkbox', { name: /Solid centre line/ }));
    expect(r.lastTags().overtaking).toBe('no');
  });

  it('sets speed limits, restrictions, structures and removes roads', () => {
    const r = renderTools();
    fireEvent.change(screen.getByLabelText('Speed limit (km/h)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Both directions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(r.lastTags().maxspeed).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    expect(r.lastTags().maxspeed).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'No trucks (hgv=no)' }));
    expect(r.lastTags().hgv).toBe('no');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Destination traffic only' }));
    expect(r.lastTags().access).toBe('destination');
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'tunnel' } });
    expect((screen.getByLabelText('Layer') as HTMLInputElement).value).toBe('-1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(r.lastTags()).toMatchObject({ tunnel: 'yes', layer: '-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove road (whole road)' }));
    expect(r.results.at(-1)!.ops[0]!.op).toBe('remove_way');
  });

  it('offers two-way conversion for one-way roads', () => {
    const r = renderTools('l4');
    expect(screen.queryByRole('checkbox', { name: 'Both directions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make two-way' }));
    expect(r.lastTags().oneway).toBe('no');
  });
});

describe('JunctionTools', () => {
  it('sets the junction control and converts to a roundabout', () => {
    const r = recorder();
    render(<JunctionTools index={index} nodeId="n0" changeset={[]} apply={r.apply} replace={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Junction control'), { target: { value: 'all_way_stop' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[0]!);
    expect(r.results.at(-1)!.ops[0]).toMatchObject({ op: 'set_node_tags', tags: { highway: 'stop', stop: 'all' } });
    fireEvent.change(screen.getByLabelText('Radius (m)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Convert to roundabout' }));
    expect(r.results.at(-1)!.ops[0]).toEqual({ op: 'convert_to_roundabout', nodeId: 100, radius: 20 });
    expect(screen.queryByText('Signal plan')).toBeNull();
  });

  it('edits the signal plan with a timeline', () => {
    const r = recorder();
    render(<JunctionTools index={signalised} nodeId="n0" changeset={[]} apply={r.apply} replace={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Timeline of one 90 s cycle' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Green time of phase 1'), { target: { value: '35' } });
    fireEvent.change(screen.getByLabelText('Phase of the approach from N'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply signal plan' }));
    expect(r.results.at(-1)!.ops[0]).toMatchObject({ op: 'set_signal_plan', phaseGreen: [35, 40], approachPhase: { '401': 0 } });
    fireEvent.change(screen.getByLabelText('Cycle (s)'), { target: { value: '60' } });
    expect(screen.getByText(/need 85 s/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply signal plan' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Fit greens to cycle' }));
    expect((screen.getByLabelText('Green time of phase 1') as HTMLInputElement).value).toBe('23');
    fireEvent.click(screen.getByRole('button', { name: '+ Phase' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove phase 3' }));
    fireEvent.change(screen.getByLabelText('Offset (s)'), { target: { value: '5' } });
    expect(screen.getAllByRole('row').length).toBeGreaterThan(4);
  });

  it('connects lanes in the junction diagram and bans or allows turns', () => {
    const r = recorder();
    const replace = vi.fn();
    const ban: EditOperation = { op: 'ban_movement', nodeId: 100, fromNeighbour: 202, toNeighbour: 301 };
    render(<JunctionTools index={index} nodeId="n0" changeset={[ban]} apply={r.apply} replace={replace} />);
    fireEvent.click(screen.getByRole('button', { name: 'Incoming lane 0 from W' }));
    expect(screen.getByText(/Lane 0 from W: click outgoing lanes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect to lane 0 to S' }));
    expect(r.results.at(-1)!.ops).toEqual([
      { op: 'set_lane_connections', nodeId: 100, fromNeighbour: 202, fromLane: 0, toNeighbour: 501, toLanes: [] },
      { op: 'set_lane_connections', nodeId: 100, fromNeighbour: 202, fromLane: 1, toNeighbour: 501, toLanes: [] },
    ]);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Disconnect to lane 0 to S' }), { key: 'Enter' });
    expect(r.apply).toHaveBeenCalledTimes(2);
    const arrows = screen.getByRole('group', { name: 'Turn markings of lane 0 from W' });
    fireEvent.click(within(arrows).getByRole('button', { name: 'through' }));
    expect((r.results.at(-1)!.ops[0] as SetWayTagsOp).tags['turn:lanes:forward']).toBe('through|right');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Incoming lane 0 from W' }), { key: 'Enter' });
    expect(screen.getByText(/Click an incoming lane/)).toBeTruthy();

    // The banned through movement W → E can be allowed again.
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(replace).toHaveBeenCalledWith('Allow through turn', []);
    const north = screen.getByRole('group', { name: 'from N' });
    fireEvent.click(within(north).getAllByRole('button', { name: 'Ban' })[0]!);
    expect(r.results.at(-1)!.label).toBe('Ban right turn');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lane 0 to lane 1, right to W' }));
    expect(r.results.at(-1)!.ops[0]).toMatchObject({ fromNeighbour: 401, toNeighbour: 202, toLanes: [0, 1] });
  });

  it('resets overridden movements', () => {
    const replace = vi.fn();
    const conn: EditOperation = { op: 'set_lane_connections', nodeId: 100, fromNeighbour: 401, fromLane: 0, toNeighbour: 202, toLanes: [1] };
    render(<JunctionTools index={index} nodeId="n0" changeset={[conn]} apply={vi.fn()} replace={replace} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(replace).toHaveBeenCalledWith('Default lanes for right turn', []);
  });

  it('explains boundary points cannot be edited', () => {
    const pkg = editorNetwork();
    pkg.nodes[1]!.osmId = null;
    render(<JunctionTools index={new PackageIndex(pkg)} nodeId="n1" changeset={[]} apply={vi.fn()} replace={vi.fn()} />);
    expect(screen.getByText(/network boundary point/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Convert to roundabout' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const lonely = editorNetwork();
    lonely.nodes.push({ id: 'n9', osmId: 9, x: 500, y: 500, z: 0, control: 'none' });
    render(<JunctionTools index={new PackageIndex(lonely)} nodeId="n9" changeset={[]} apply={vi.fn()} replace={vi.fn()} />);
    expect(screen.getByText('No movements at this point.')).toBeTruthy();
  });
});

describe('EditorPanel', () => {
  it('shows link tools with a scope switch, junction tools, or nothing', () => {
    const onScope = vi.fn();
    const s = session();
    const { rerender } = render(<EditorPanel index={index} target={{ kind: 'lane', linkId: 'l2', laneIndex: 0 }} session={s} scope="part" onScope={onScope} />);
    expect(screen.getByRole('heading', { name: 'Edit road l2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Whole road' }));
    expect(onScope).toHaveBeenCalledWith('way');
    fireEvent.click(screen.getByRole('button', { name: '+ Lane on the left' }));
    expect(s.apply).toHaveBeenCalled();
    rerender(<EditorPanel index={index} target={{ kind: 'connector', connectorId: 'c1' }} session={s} scope="part" onScope={onScope} />);
    expect(screen.getByRole('heading', { name: 'Edit junction n0' })).toBeTruthy();
    rerender(<EditorPanel index={index} target={null} session={s} scope="part" onScope={onScope} />);
    expect(screen.queryByRole('region', { name: 'Edit tools' })).toBeNull();
  });
});

describe('DrawRoadPanel', () => {
  it('edits the road spec and finishes, steps back or cancels', () => {
    const draft: RoadDraft = {
      points: [
        { kind: 'node', osmId: 1, nodeId: 'n1', x: 0, y: 0 },
        { kind: 'free', x: 10, y: 0 },
      ],
      spec: DEFAULT_ROAD,
      setSpec: vi.fn(),
      add: vi.fn(),
      back: vi.fn(),
      cancel: vi.fn(),
      finish: vi.fn(),
    };
    const onFinish = vi.fn();
    render(<DrawRoadPanel draft={draft} onFinish={onFinish} />);
    expect(screen.getByRole('status').textContent).toBe('2 points, 1 connected to the network');
    fireEvent.change(screen.getByLabelText('Class'), { target: { value: 'primary' } });
    expect(draft.setSpec).toHaveBeenLastCalledWith({ ...DEFAULT_ROAD, highway: 'primary' });
    fireEvent.change(screen.getByLabelText('Structure'), { target: { value: 'bridge' } });
    expect(draft.setSpec).toHaveBeenLastCalledWith({ ...DEFAULT_ROAD, structure: 'bridge', layer: 1 });
    fireEvent.change(screen.getByLabelText('Speed (km/h)'), { target: { value: '50' } });
    expect(draft.setSpec).toHaveBeenLastCalledWith({ ...DEFAULT_ROAD, maxspeed: 50 });
    fireEvent.change(screen.getByLabelText('Lanes per direction'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('One-way'));
    fireEvent.change(screen.getByLabelText('Layer'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New St' } });
    expect(draft.setSpec).toHaveBeenLastCalledWith({ ...DEFAULT_ROAD, name: 'New St' });
    fireEvent.click(screen.getByRole('button', { name: 'Finish road' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove last point' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onFinish).toHaveBeenCalled();
    expect(draft.back).toHaveBeenCalled();
    expect(draft.cancel).toHaveBeenCalled();
  });
});
