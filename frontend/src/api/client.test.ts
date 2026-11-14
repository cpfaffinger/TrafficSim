import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('ApiClient', () => {
  it('loads meta information', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ name: 'TrafficSim', version: '0.1.0', attributions: ['OSM'] }));
    const client = new ApiClient(fetchFn);

    const meta = await client.getMeta();

    expect(meta.version).toBe('0.1.0');
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/meta', expect.objectContaining({ headers: { Accept: 'application/json' } }));
  });

  it('encodes geocoding queries', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ results: [], provider: 'photon', attribution: 'x' }));
    const client = new ApiClient(fetchFn, 'https://example.test');

    await client.geocode('Ring Straße & Co', 3);

    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://example.test/api/v1/geocode?q=Ring+Stra%C3%9Fe+%26+Co&limit=3');
  });

  it('passes the language to the geocoder', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ results: [], provider: 'photon', attribution: 'x' }));
    await new ApiClient(fetchFn).geocode('Wien', 5, undefined, 'de');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/v1/geocode?q=Wien&limit=5&lang=de');
  });

  it('renames and deletes imports (#114)', async () => {
    const fetchFn = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ id: 'b1', name: 'New' })),
    );
    const client = new ApiClient(fetchFn);
    expect(await client.renameNetwork('b1', 'New')).toMatchObject({ name: 'New' });
    expect(fetchFn.mock.calls[0]).toEqual(['/api/v1/networks/b1', expect.objectContaining({ method: 'PATCH' })]);
    await client.deleteNetwork('b1');
    expect(fetchFn.mock.calls[1]![1]).toMatchObject({ method: 'DELETE' });
    const failing = new ApiClient(vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(failing.deleteNetwork('x')).rejects.toBeInstanceOf(ApiError);
    await new ApiClient(vi.fn().mockResolvedValue(new Response(null, { status: 404 }))).deleteNetwork('gone');
  });

  it('starts imports with a JSON body', async () => {
    const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(json({ jobId: 'j1', status: 'queued', baselineId: null }, 202)));
    const job = await new ApiClient(fetchFn).startImport([16.37, 48.2, 16.38, 48.21]);
    expect(job).toEqual({ jobId: 'j1', status: 'queued', baselineId: null });
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/v1/networks/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ bbox: [16.37, 48.2, 16.38, 48.21] });
    await new ApiClient(fetchFn).startImport([
      [16.37, 48.2],
      [16.38, 48.2],
      [16.375, 48.21],
    ]);
    expect(JSON.parse((fetchFn.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      polygon: [
        [16.37, 48.2],
        [16.38, 48.2],
        [16.375, 48.21],
      ],
    });
  });

  it('reports a too-large area from problem details', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ title: 'Area too large', detail: 'The area must not exceed 25 km².' }, 422));
    await expect(new ApiClient(fetchFn).startImport([0, 0, 1, 1])).rejects.toEqual(new ApiError(422, 'The area must not exceed 25 km².'));
  });

  it('polls jobs, loads packages and lists recent networks', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ jobId: 'a/b', status: 'fetching', baselineId: null, error: null }))
      .mockResolvedValueOnce(json({ formatVersion: 1 }))
      .mockResolvedValueOnce(json([{ id: 'b1' }]));
    const client = new ApiClient(fetchFn);
    expect((await client.getImportJob('a/b')).status).toBe('fetching');
    expect(await client.getPackage('b 1')).toEqual({ formatVersion: 1 });
    expect(await client.listNetworks(5)).toEqual([{ id: 'b1' }]);
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/networks/import/a%2Fb',
      '/api/v1/networks/b%201/package',
      '/api/v1/networks?limit=5',
    ]);
  });

  it('turns problem details into ApiError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ title: 'Invalid', detail: 'Query text must not be empty.' }, 400));
    const client = new ApiClient(fetchFn);

    await expect(client.geocode('')).rejects.toEqual(new ApiError(400, 'Query text must not be empty.'));
  });

  it('falls back to status text for non-JSON errors', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('oops', { status: 502, statusText: 'Bad Gateway' }));
    const client = new ApiClient(fetchFn);

    await expect(client.getMeta()).rejects.toMatchObject({ status: 502, message: 'Bad Gateway' });
  });

  it.each([
    [200, 200, 'ok'],
    [200, 503, 'degraded'],
    [503, 200, 'down'],
  ] as const)('maps healthz %i / readyz %i to %s', async (live, ready, expected) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: live }))
      .mockResolvedValueOnce(new Response(null, { status: ready }));

    expect(await new ApiClient(fetchFn).getStatus()).toBe(expected);
  });

  it('reports down on network errors but rethrows aborts', async () => {
    const failing = new ApiClient(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await failing.getStatus()).toBe('down');

    const aborted = new ApiClient(vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
    await expect(aborted.getStatus()).rejects.toThrow('aborted');
  });
});
