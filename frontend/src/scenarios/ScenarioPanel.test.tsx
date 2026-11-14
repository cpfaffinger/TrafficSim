// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Scenario } from '../api/scenarioClient';
import type { EditOperation } from '../editor/ops';
import { editorNetwork } from '../test/editorNetwork';
import { ScenarioPanel, type ScenarioApi } from './ScenarioPanel';
import { SharedScenarioPanel, type SharedApi } from './SharedScenarioPanel';

afterEach(cleanup);

const ban: EditOperation = { op: 'ban_movement', nodeId: 1, fromNeighbour: 2, toNeighbour: 3 };
const make = (id: string, name: string, changeset: EditOperation[] = []): Scenario => ({
  id,
  name,
  baselineId: 'b1',
  parentId: null,
  changeset,
  demand: null,
  seed: 1,
  durationSeconds: 3600,
  shareToken: `token_${id}_abcdef`,
  createdAt: '2026-11-14T10:00:00Z',
  updatedAt: '2026-11-14T10:00:00Z',
});
const a = make('s1', 'Base', [ban]);
const b = make('s2', 'Variant 2');

function api(): { [K in keyof ScenarioApi]: Mock<ScenarioApi[K]> } {
  return {
    listScenarios: vi.fn().mockResolvedValue([a, b]),
    createScenario: vi.fn().mockImplementation((input: { name: string; changeset: EditOperation[] }) => Promise.resolve(make('s3', input.name, input.changeset))),
    updateScenario: vi.fn().mockImplementation((_id: string, input: Partial<Scenario>) => Promise.resolve({ ...a, ...input, updatedAt: 'later' })),
    deleteScenario: vi.fn().mockResolvedValue(undefined),
    cloneScenario: vi.fn().mockResolvedValue(make('s4', 'Base (variant)', [ban])),
    listRuns: vi.fn().mockResolvedValue([{ id: 'r1', scenarioId: 's1', seed: 3, simulatedSeconds: 60, summary: {}, bucketFormat: '', createdAt: '2026-11-14T11:00:00Z' }]),
  };
}

function session(over: Partial<Parameters<typeof ScenarioPanel>[0]['session']> = {}) {
  return {
    baselineId: 'b1',
    scenario: null as Scenario | null,
    dirty: false,
    changeset: [] as EditOperation[],
    openScenario: vi.fn().mockResolvedValue(undefined),
    setScenario: vi.fn(),
    ...over,
  };
}

const location = { origin: 'https://ts.test', pathname: '/' };

describe('ScenarioPanel (#72)', () => {
  it('lists scenarios and opens one, asking before discarding edits', async () => {
    const s = session({ scenario: a, dirty: true });
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ScenarioPanel api={api()} session={s} confirm={confirm} location={location} />);
    const variant = await screen.findByRole('button', { name: /Variant 2/ });
    expect(screen.getByRole('button', { name: /Base \(open\)/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('1 edit · seed 1 · 60 min')).toBeTruthy();
    fireEvent.click(variant);
    expect(s.openScenario).not.toHaveBeenCalled();
    fireEvent.click(variant);
    await waitFor(() => expect(s.openScenario).toHaveBeenCalledWith(b));
    fireEvent.click(screen.getByRole('button', { name: /Base \(open\)/ }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('saves a draft as a new scenario', async () => {
    const s = session({ changeset: [ban] });
    const client = api();
    render(<ScenarioPanel api={client} session={s} location={location} />);
    await screen.findByRole('button', { name: /Variant 2/ });
    fireEvent.change(screen.getByLabelText('New scenario name'), { target: { value: 'Bus lanes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft as scenario' }));
    await screen.findByText('Created “Bus lanes”.');
    expect(client.createScenario).toHaveBeenCalledWith({ name: 'Bus lanes', baselineId: 'b1', changeset: [ban] });
    expect(s.openScenario).toHaveBeenCalledWith(expect.objectContaining({ id: 's3' }));
  });

  it('creates empty scenarios with a proposed name', async () => {
    const client = api();
    render(<ScenarioPanel api={client} session={session({ scenario: a })} location={location} />);
    await screen.findByRole('button', { name: /Variant 2/ });
    expect(screen.getByPlaceholderText('Variant 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New scenario' }));
    await screen.findByText('Created “Variant 3”.');
    expect(client.createScenario).toHaveBeenCalledWith({ name: 'Variant 3', baselineId: 'b1', changeset: [] });
  });

  it('validates and saves settings', async () => {
    const s = session({ scenario: a });
    const client = api();
    render(<ScenarioPanel api={client} session={s} location={location} />);
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByText('The seed is a whole number.')).toBeTruthy();
    expect(screen.getByLabelText('Seed').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText('Duration (min)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Demand (JSON, optional)'), { target: { value: '{"trips": 10}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    expect(client.updateScenario).toHaveBeenCalledWith('s1', { name: 'Renamed', seed: 9, durationSeconds: 1800, demand: { trips: 10 } });
    expect(s.setScenario).toHaveBeenCalledWith(expect.objectContaining({ name: 'Renamed' }));
  });

  it('clones, deletes and shares the open scenario', async () => {
    const s = session({ scenario: a, dirty: true });
    const client = api();
    const confirm = vi.fn().mockReturnValue(true);
    const copy = vi.fn().mockResolvedValue(undefined);
    render(<ScenarioPanel api={client} session={s} confirm={confirm} copy={copy} location={location} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clone as variant' }));
    await screen.findByText('Created variant “Base (variant)”.');
    expect(client.cloneScenario).toHaveBeenCalledWith('s1', 'Base (variant)');

    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    await screen.findByText(/Link copied. It shows the saved state/);
    expect(copy).toHaveBeenCalledWith('https://ts.test/?share=token_s1_abcdef');
    expect((screen.getByLabelText('Read-only share link') as HTMLInputElement).value).toBe('https://ts.test/?share=token_s1_abcdef');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Deleted “Base”.');
    expect(client.deleteScenario).toHaveBeenCalledWith('s1');
    expect(s.setScenario).toHaveBeenCalledWith(null);
  });

  it('lists exports and reports failures', async () => {
    const client = api();
    client.cloneScenario.mockRejectedValue(new Error('Server down'));
    render(<ScenarioPanel api={client} session={session({ scenario: a })} copy={vi.fn().mockRejectedValue(new Error('denied'))} location={location} />);
    expect(screen.getByRole('link', { name: 'Network (GeoJSON)' }).getAttribute('href')).toBe('/api/v1/scenarios/s1/export/network.geojson');
    expect((await screen.findByRole('link', { name: 'links CSV' })).getAttribute('href')).toBe('/api/v1/runs/r1/export/links.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Clone as variant' }));
    await screen.findByText('Server down');
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    await screen.findByText('Copy the read-only link below.');
  });

  it('renders nothing without a baseline', () => {
    const { container } = render(<ScenarioPanel api={api()} session={session({ baselineId: null })} location={location} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('SharedScenarioPanel (#76)', () => {
  const sharedApi = (over: Partial<SharedApi> = {}): SharedApi => ({
    getShared: vi.fn().mockResolvedValue({ ...a, shareToken: null }),
    getSharedPackage: vi.fn().mockResolvedValue({ pkg: editorNetwork(), issues: [] }),
    listRuns: vi.fn().mockResolvedValue([]),
    ...over,
  });

  it('loads the shared scenario read-only', async () => {
    const onPackage = vi.fn();
    render(<SharedScenarioPanel api={sharedApi()} token="token_abcdefgh" onPackage={onPackage} location={location} />);
    expect(screen.getByText('Read-only')).toBeTruthy();
    await screen.findByText('Base');
    expect(onPackage).toHaveBeenCalledWith(expect.objectContaining({ formatVersion: 1 }));
    expect(screen.getByRole('link', { name: 'Open the editor' }).getAttribute('href')).toBe('https://ts.test/');
    expect(screen.getByRole('link', { name: 'Network (GeoJSON)' })).toBeTruthy();
  });

  it('explains broken links', async () => {
    const api = sharedApi({ getShared: vi.fn().mockRejectedValue(new Error('share link not found')) });
    await act(async () => {
      render(<SharedScenarioPanel api={api} token="token_abcdefgh" onPackage={vi.fn()} location={location} />);
    });
    expect(screen.getByRole('alert').textContent).toContain('share link not found');
  });
});
