import { describe, expect, it, vi } from 'vitest';
import { shareTokenFrom, shareUrl, editorUrl } from '../scenarios/shareUrl';
import { ApiError } from './client';
import { ChangesetRejectedError, exportUrls, parseIssueHeaders, ScenarioClient } from './scenarioClient';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const scenario = {
  id: 's1',
  name: 'Variant A',
  baselineId: 'b1',
  parentId: null,
  changeset: [{ op: 'ban_movement', nodeId: 1, fromNeighbour: 2, toNeighbour: 3 }],
  demand: null,
  seed: 7,
  durationSeconds: 1800,
  shareToken: 'tok_12345678',
  createdAt: '2026-11-14T10:00:00Z',
  updatedAt: '2026-11-14T10:00:00Z',
};

describe('ScenarioClient', () => {
  it('lists scenarios of a baseline', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json([scenario, {}]));
    const list = await new ScenarioClient(fetchFn).listScenarios('b 1');
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/v1/scenarios?baselineId=b%201&limit=100');
    expect(list[0]).toEqual(scenario);
    expect(list[1]).toMatchObject({ name: 'Scenario', changeset: [], seed: 1, durationSeconds: 3600, shareToken: null });
  });

  it('creates, updates, clones and deletes scenarios', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(scenario, 201))
      .mockResolvedValueOnce(json({ ...scenario, name: 'B' }))
      .mockResolvedValueOnce(json({ ...scenario, id: 's2' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(scenario));
    const c = new ScenarioClient(fetchFn, 'https://x.test');
    await c.createScenario({ name: 'A', baselineId: 'b1', changeset: [] });
    expect((await c.updateScenario('s1', { name: 'B' })).name).toBe('B');
    expect((await c.cloneScenario('s1', 'Copy')).id).toBe('s2');
    await c.deleteScenario('s1');
    await c.getScenario('s1');
    const calls = fetchFn.mock.calls as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'POST https://x.test/api/v1/scenarios',
      'PUT https://x.test/api/v1/scenarios/s1',
      'POST https://x.test/api/v1/scenarios/s1/clone',
      'DELETE https://x.test/api/v1/scenarios/s1',
      'GET https://x.test/api/v1/scenarios/s1',
    ]);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ name: 'A', baselineId: 'b1', changeset: [] });
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({ name: 'Copy' });
    expect(calls[4]![1].body).toBeUndefined();
  });

  it('previews a changeset and reports skipped edits', async () => {
    const list = encodeURIComponent(JSON.stringify([{ operationIndex: 1, operation: 'SetWayTags', message: 'way 5 not found' }]));
    const fetchFn = vi.fn().mockResolvedValue(json({ formatVersion: 1 }, 200, { 'X-TrafficSim-Edit-Issues': '1', 'X-TrafficSim-Edit-Issue-List': list }));
    const changeset = [{ op: 'set_node_tags' as const, nodeId: 1, tags: { highway: 'stop' } }];
    const r = await new ScenarioClient(fetchFn).preview('b1', changeset);
    expect(r.pkg).toEqual({ formatVersion: 1 });
    expect(r.issues).toEqual([{ operationIndex: 1, operation: 'SetWayTags', message: 'way 5 not found' }]);
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/v1/networks/b1/preview');
    expect(JSON.parse(init.body as string)).toEqual({ changeset });
  });

  it('loads scenario, shared and run data', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ formatVersion: 1 }))
      .mockResolvedValueOnce(json({ ...scenario, shareToken: null }))
      .mockResolvedValueOnce(json({ formatVersion: 1 }))
      .mockResolvedValueOnce(json([{ id: 'r1' }]))
      .mockResolvedValueOnce(json({}));
    const c = new ScenarioClient(fetchFn);
    expect((await c.getScenarioPackage('s1')).issues).toEqual([]);
    expect((await c.getShared('tok')).shareToken).toBeNull();
    await c.getSharedPackage('tok');
    expect(await c.listRuns('s1')).toEqual([{ id: 'r1' }]);
    expect(await c.listRuns('s1')).toEqual([]);
    expect(fetchFn.mock.calls.map((x) => x[0])).toEqual([
      '/api/v1/scenarios/s1/package',
      '/api/v1/shared/tok',
      '/api/v1/shared/tok/package',
      '/api/v1/scenarios/s1/runs',
      '/api/v1/scenarios/s1/runs',
    ]);
  });

  it('turns 422 problems into rejected changesets and other errors into ApiError', async () => {
    const problem = { title: 'Changeset cannot be applied', detail: '1 edit', issues: [{ operationIndex: 0, operation: 'BanMovement', message: 'node 1 not found' }] };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(problem, 422))
      .mockResolvedValueOnce(json({ title: 'Not found' }, 404))
      .mockResolvedValueOnce(new Response('oops', { status: 500, statusText: 'Server Error' }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const c = new ScenarioClient(fetchFn);
    const rejected = await c.updateScenario('s1', { changeset: [] }).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ChangesetRejectedError);
    expect((rejected as ChangesetRejectedError).issues).toEqual(problem.issues);
    await expect(c.getScenario('x')).rejects.toEqual(new ApiError(404, 'Not found'));
    await expect(c.preview('b', [])).rejects.toEqual(new ApiError(500, 'Server Error'));
    await expect(c.deleteScenario('gone')).resolves.toBeUndefined();
    await expect(c.deleteScenario('x')).rejects.toEqual(new ApiError(500, 'HTTP 500'));
  });

  it('parses issue headers defensively', () => {
    expect(parseIssueHeaders(null, null)).toEqual([]);
    expect(parseIssueHeaders('2', '%%%')).toEqual([{ operationIndex: -1, operation: '', message: '2 edits could not be applied' }]);
    expect(parseIssueHeaders('1', null)[0]!.message).toBe('1 edit could not be applied');
    expect(parseIssueHeaders('1', encodeURIComponent('[{"x":1}, 3]'))).toEqual([{ operationIndex: -1, operation: '', message: 'Edit could not be applied' }]);
    expect(parseIssueHeaders('0', encodeURIComponent('{}'))).toEqual([]);
  });

  it('builds export URLs', () => {
    expect(exportUrls.networkGeoJson('s/1')).toBe('/api/v1/scenarios/s%2F1/export/network.geojson');
    expect(exportUrls.runLinksCsv('r1')).toBe('/api/v1/runs/r1/export/links.csv');
    expect(exportUrls.runLinksGeoJson('r1')).toBe('/api/v1/runs/r1/export/links.geojson');
    expect(exportUrls.runSummaryCsv('r1')).toBe('/api/v1/runs/r1/export/summary.csv');
  });
});

describe('share URLs (#76)', () => {
  it('reads and writes share tokens', () => {
    expect(shareTokenFrom('?share=abc_DEF-123')).toBe('abc_DEF-123');
    expect(shareTokenFrom('?x=1')).toBeNull();
    expect(shareTokenFrom('?share=<script>')).toBeNull();
    expect(shareTokenFrom('?share=short')).toBeNull();
    const loc = { origin: 'https://example.test', pathname: '/app/' };
    expect(shareUrl('abc_DEF-123', loc)).toBe('https://example.test/app/?share=abc_DEF-123');
    expect(editorUrl(loc)).toBe('https://example.test/app/');
  });
});
