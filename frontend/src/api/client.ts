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

  async geocode(query: string, limit = 5, signal?: AbortSignal): Promise<GeocodeResponse> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return this.getJson<GeocodeResponse>(`/api/v1/geocode?${params.toString()}`, signal);
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
