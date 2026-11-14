// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '../api/scenarioClient';
import { ScenarioPanel } from '../scenarios/ScenarioPanel';
import { SharedScenarioPanel } from '../scenarios/SharedScenarioPanel';
import { fixturePackage, generatedDemand } from '../test/demandFixtures';
import { FALLBACK_BUILTINS } from './builtins';
import { DemandEditorHost, demandPick } from './DemandEditorHost';
import { DemandOverlay } from './DemandOverlay';
import { parseDemand } from './model';
import { zoneShapes } from './zones';

vi.mock('./demand.css', () => ({}));
afterEach(cleanup);

const pkg = fixturePackage();
const fakeScene = () => ({ addOverlay: vi.fn(), removeOverlay: vi.fn(), invalidate: vi.fn() });
const nodes = new Map(pkg.nodes.map((n) => [n.id, [n.x, n.y] as const]));

describe('DemandOverlay', () => {
  it('draws zone outlines and emphasises the selected zones and nodes', () => {
    const scene = fakeScene();
    const overlay = new DemandOverlay(scene);
    expect(scene.addOverlay).toHaveBeenCalledTimes(1);
    const shapes = zoneShapes(
      [
        { id: 'a', nodes: [], links: ['l1', 'l5'] },
        { id: 'b', nodes: [], links: ['l2', 'l9'] },
        { id: 'ext', nodes: ['n1', 'n2'], links: [] },
      ],
      pkg,
    );
    overlay.show(shapes, { zone: null, from: null, to: null, nodes: [] }, nodes);
    const idle = overlay.size;
    expect(idle).toBe(3); // two outlines + one marker cloud
    overlay.show(shapes, { zone: null, from: 'a', to: 'ext', nodes: ['n3', 'nope'] }, nodes);
    expect(overlay.size).toBeGreaterThan(idle);
    overlay.show(shapes, { zone: 'b', from: 'a', to: 'a', nodes: [] }, nodes);
    expect(scene.invalidate).toHaveBeenCalledTimes(3);
    overlay.dispose();
    expect(overlay.size).toBe(0);
    expect(scene.removeOverlay).toHaveBeenCalledTimes(1);
  });
});

describe('DemandEditorHost', () => {
  it('maps picks to links with end nodes or nodes', () => {
    expect(demandPick(pkg, null)).toBeNull();
    expect(demandPick(pkg, { kind: 'connector', connectorId: 'c1' })).toBeNull();
    expect(demandPick(pkg, { kind: 'node', nodeId: 'n1' })).toEqual({ nodeIds: ['n1'] });
    expect(demandPick(pkg, { kind: 'lane', linkId: 'l1', laneIndex: 0 })).toEqual({ linkId: 'l1', nodeIds: ['n1', 'n0'] });
    expect(demandPick(pkg, { kind: 'link', linkId: 'zz' })).toEqual({ linkId: 'zz', nodeIds: [] });
  });

  it('loads the WASM catalogues, draws the overlay and follows map picks', async () => {
    const scene = fakeScene();
    const load = vi.fn().mockResolvedValue({ ...FALLBACK_BUILTINS, vehicleTypes: [...FALLBACK_BUILTINS.vehicleTypes, 'tram'] });
    const scenario = { id: 's1', name: 'Morning', demand: generatedDemand('morning'), durationSeconds: 3600 };
    const props = { scenario, pkg, sceneRef: { current: scene }, readOnly: false, onClose: vi.fn(), loadBuiltins: load };
    const view = render(<DemandEditorHost {...props} target={null} />);
    expect(scene.addOverlay).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: /Mixes/ }));
    await screen.findByText('tram');
    view.rerender(<DemandEditorHost {...props} target={{ kind: 'link', linkId: 'l5' }} />);
    expect((screen.getByLabelText('Zone') as HTMLSelectElement).value).toBe('z-1_0');
    const invalidations = scene.invalidate.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'z0_0' } });
    expect(scene.invalidate.mock.calls.length).toBeGreaterThan(invalidations);
    view.unmount();
    expect(scene.removeOverlay).toHaveBeenCalled();
  });

  it('keeps the fallback catalogues when WASM cannot load, and works without a scene', async () => {
    const load = vi.fn().mockRejectedValue(new Error('no wasm'));
    const scenario = { id: 's1', name: 'Empty', demand: null, durationSeconds: 3600 };
    render(<DemandEditorHost scenario={scenario} pkg={pkg} sceneRef={{ current: null }} target={null} readOnly onClose={vi.fn()} loadBuiltins={load} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: /Mixes/ }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(parseDemand(scenario.demand).zones).toEqual([]);
  });
});

describe('scenario panels open the demand editor', () => {
  const s: Scenario = {
    id: 's1',
    name: 'Morning',
    baselineId: 'b1',
    parentId: null,
    changeset: [],
    demand: generatedDemand('morning'),
    seed: 1,
    durationSeconds: 3600,
    shareToken: 'tok',
    createdAt: '',
    updatedAt: '',
  };

  it('offers “Edit demand” for the open scenario', async () => {
    const onEditDemand = vi.fn();
    const api = {
      listScenarios: vi.fn().mockResolvedValue([s]),
      createScenario: vi.fn(),
      updateScenario: vi.fn(),
      deleteScenario: vi.fn(),
      cloneScenario: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
    };
    const session = { baselineId: 'b1', scenario: s, dirty: false, changeset: [], openScenario: vi.fn(), setScenario: vi.fn() };
    render(<ScenarioPanel api={api} session={session} onEditDemand={onEditDemand} location={{ origin: 'https://t.test', pathname: '/' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit demand' }));
    expect(onEditDemand).toHaveBeenCalled();
  });

  it('offers “View demand” for a shared scenario', async () => {
    const onShowDemand = vi.fn();
    const api = {
      getShared: vi.fn().mockResolvedValue(s),
      getSharedPackage: vi.fn().mockResolvedValue({ pkg, issues: [] }),
      listRuns: vi.fn().mockResolvedValue([]),
    };
    render(<SharedScenarioPanel api={api} token="tok" onPackage={vi.fn()} onShowDemand={onShowDemand} location={{ origin: 'https://t.test', pathname: '/' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View demand' }));
    expect(onShowDemand).toHaveBeenCalledWith(s);
  });
});
