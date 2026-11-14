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
