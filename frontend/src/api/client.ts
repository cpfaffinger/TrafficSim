/** Typed client for the TrafficSim backend API (same origin). */

export interface MetaResponse {
  name: string;
  version: string;
  attributions: string[];
}

export interface GeocodeResult {
  label: string;
  latitude: number;
  longitude: number;
  category: string;
  bbox: [number, number, number, number] | null;
  osmReference: string | null;
}

export interface GeocodeResponse {
  results: GeocodeResult[];
  provider: string;
  attribution: string;
}

export type BackendStatus = 'ok' | 'degraded' | 'down';

export type ImportStatus = 'queued' | 'fetching' | 'compiling' | 'storing' | 'completed' | 'failed';

export interface ImportJob {
  jobId: string | null;
  status: ImportStatus;
  baselineId: string | null;
  error?: string | null;
}

export interface NetworkSummary {
  id: string;
  /** User-facing name (#114). */
  name?: string | null;
  bbox: [number, number, number, number];
  /** Import polygon for non-rectangular imports (#110). */
  polygon?: [number, number][] | null;
  createdAt: string;
  source: string;
  stats: { nodes: number; links: number; lanes: number; connectors: number; signals: number };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Fetch = typeof fetch;

export class ApiClient {
  constructor(
    private readonly fetchFn: Fetch = (input, init) => fetch(input, init),
    private readonly baseUrl = '',
  ) {}

  async getMeta(signal?: AbortSignal): Promise<MetaResponse> {
    return this.getJson<MetaResponse>('/api/v1/meta', signal);
  }

  async geocode(query: string, limit = 5, signal?: AbortSignal, lang?: string): Promise<GeocodeResponse> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (lang) params.set('lang', lang);
    return this.getJson<GeocodeResponse>(`/api/v1/geocode?${params.toString()}`, signal);
  }

  /** Starts (or reuses) an import of the area; `202` while running, `200` if an identical import exists. */
  /** Starts an import of a `[w, s, e, n]` box or a `[lon, lat][]` polygon ring (#110). */
  async startImport(
    area: readonly [number, number, number, number] | readonly (readonly [number, number])[],
    signal?: AbortSignal,
    name?: string,
  ): Promise<ImportJob> {
    const shape = area.length > 0 && Array.isArray(area[0]) ? { polygon: area } : { bbox: area };
    const body = name ? { ...shape, name } : shape;
    return this.sendJson<ImportJob>('POST', '/api/v1/networks/import', body, signal);
  }

  async getImportJob(jobId: string, signal?: AbortSignal): Promise<ImportJob> {
    return this.getJson<ImportJob>(`/api/v1/networks/import/${encodeURIComponent(jobId)}`, signal);
  }

  /** Raw network package JSON; validate with `parseNetworkPackage`. */
  async getPackage(baselineId: string, signal?: AbortSignal): Promise<unknown> {
    return this.getJson<unknown>(`/api/v1/networks/${encodeURIComponent(baselineId)}/package`, signal);
  }

  /** Renames an import (#114). */
  async renameNetwork(id: string, name: string, signal?: AbortSignal): Promise<NetworkSummary> {
    return this.sendJson<NetworkSummary>('PATCH', `/api/v1/networks/${encodeURIComponent(id)}`, { name }, signal);
  }

  /** Deletes an import with its scenarios and runs (#114). */
  async deleteNetwork(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/api/v1/networks/${encodeURIComponent(id)}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
    if (!response.ok && response.status !== 404) throw new ApiError(response.status, `Deleting failed (HTTP ${response.status}).`);
  }

  async listNetworks(limit = 20, signal?: AbortSignal): Promise<NetworkSummary[]> {
    return this.getJson<NetworkSummary[]>(`/api/v1/networks?limit=${limit}`, signal);
  }

  /** Liveness + readiness combined into a single traffic-light status. */
  async getStatus(signal?: AbortSignal): Promise<BackendStatus> {
    try {
      const live = await this.fetchFn(`${this.baseUrl}/healthz`, { signal });
      if (!live.ok) return 'down';
      const ready = await this.fetchFn(`${this.baseUrl}/readyz`, { signal });
      return ready.ok ? 'ok' : 'degraded';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return 'down';
    }
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    return this.readJson<T>(response);
  }

  private async sendJson<T>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.readJson<T>(response);
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const problem = (await response.json()) as { title?: string; detail?: string };
        detail = problem.detail ?? problem.title ?? detail;
      } catch {
        // Body is not JSON; keep the status text.
      }
      throw new ApiError(response.status, detail);
    }
    return (await response.json()) as T;
  }
}
