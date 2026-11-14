import { parseChangeset, type Changeset, type EditOperation } from '../editor/ops';
import { ApiError } from './client';

/** Scenarios, changeset previews, runs, sharing and exports (ADR-0010, #70, #72, #75, #76). */

export interface Scenario {
  id: string;
  name: string;
  baselineId: string;
  parentId: string | null;
  changeset: EditOperation[];
  /** Opaque for now (Phase 5 adds a demand editor). */
  demand: unknown;
  seed: number;
  durationSeconds: number;
  /** Null in read-only (shared) responses. */
  shareToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioInput {
  name?: string;
  baselineId?: string;
  changeset?: Changeset;
  demand?: unknown;
  seed?: number;
  durationSeconds?: number;
}

export interface RunSummary {
  id: string;
  scenarioId: string;
  seed: number;
  simulatedSeconds: number;
  summary: unknown;
  bucketFormat: string;
  createdAt: string;
}

/** An edit the backend skipped (target missing, invalid value, …). */
export interface EditIssue {
  operationIndex: number;
  operation: string;
  message: string;
}

/** A compiled package plus the edits that could not be applied. */
export interface PackageResult {
  /** Raw package JSON; validate with `parseNetworkPackage`. */
  pkg: unknown;
  issues: EditIssue[];
}

/** 422: the changeset cannot be saved because some edits cannot be applied. */
export class ChangesetRejectedError extends ApiError {
  constructor(
    message: string,
    readonly issues: EditIssue[],
  ) {
    super(422, message);
    this.name = 'ChangesetRejectedError';
  }
}

export const ISSUE_COUNT_HEADER = 'X-TrafficSim-Edit-Issues';
export const ISSUE_LIST_HEADER = 'X-TrafficSim-Edit-Issue-List';

function toIssues(value: unknown): EditIssue[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .map((i) => ({
      operationIndex: typeof i.operationIndex === 'number' ? i.operationIndex : -1,
      operation: typeof i.operation === 'string' ? i.operation : '',
      message: typeof i.message === 'string' ? i.message : 'Edit could not be applied',
    }));
}

/** Reads the skipped-edit headers; an unreadable list still reports the count. */
export function parseIssueHeaders(count: string | null, list: string | null): EditIssue[] {
  const n = Number(count ?? 0);
  let issues: EditIssue[] = [];
  if (list) {
    try {
      issues = toIssues(JSON.parse(decodeURIComponent(list)));
    } catch {
      issues = [];
    }
  }
  if (issues.length === 0 && Number.isFinite(n) && n > 0) {
    issues = [{ operationIndex: -1, operation: '', message: `${n} edit${n === 1 ? '' : 's'} could not be applied` }];
  }
  return issues;
}

function toScenario(raw: unknown): Scenario {
  const s = (raw ?? {}) as Partial<Scenario> & { changeset?: unknown };
  return {
    id: String(s.id ?? ''),
    name: String(s.name ?? 'Scenario'),
    baselineId: String(s.baselineId ?? ''),
    parentId: s.parentId ?? null,
    changeset: parseChangeset(s.changeset),
    demand: s.demand ?? null,
    seed: typeof s.seed === 'number' ? s.seed : 1,
    durationSeconds: typeof s.durationSeconds === 'number' ? s.durationSeconds : 3600,
    shareToken: s.shareToken ?? null,
    createdAt: String(s.createdAt ?? ''),
    updatedAt: String(s.updatedAt ?? ''),
  };
}

type Fetch = typeof fetch;
const enc = encodeURIComponent;

export class ScenarioClient {
  constructor(
    private readonly fetchFn: Fetch = (input, init) => fetch(input, init),
    private readonly baseUrl = '',
  ) {}

  async listScenarios(baselineId: string, signal?: AbortSignal): Promise<Scenario[]> {
    const list = await this.json<unknown[]>('GET', `/api/v1/scenarios?baselineId=${enc(baselineId)}&limit=100`, undefined, signal);
    return Array.isArray(list) ? list.map(toScenario) : [];
  }

  async createScenario(input: ScenarioInput & { baselineId: string }, signal?: AbortSignal): Promise<Scenario> {
    return toScenario(await this.json('POST', '/api/v1/scenarios', input, signal));
  }

  async getScenario(id: string, signal?: AbortSignal): Promise<Scenario> {
    return toScenario(await this.json('GET', `/api/v1/scenarios/${enc(id)}`, undefined, signal));
  }

  /** Updates the given fields only. */
  async updateScenario(id: string, input: ScenarioInput, signal?: AbortSignal): Promise<Scenario> {
    return toScenario(await this.json('PUT', `/api/v1/scenarios/${enc(id)}`, input, signal));
  }

  async deleteScenario(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/api/v1/scenarios/${enc(id)}`, { method: 'DELETE', signal });
    if (!response.ok && response.status !== 404) await this.fail(response);
  }

  async cloneScenario(id: string, name?: string, signal?: AbortSignal): Promise<Scenario> {
    return toScenario(await this.json('POST', `/api/v1/scenarios/${enc(id)}/clone`, name ? { name } : {}, signal));
  }

  async getScenarioPackage(id: string, signal?: AbortSignal): Promise<PackageResult> {
    return this.packageRequest('GET', `/api/v1/scenarios/${enc(id)}/package`, undefined, signal);
  }

  /** Compiles baseline + changeset without saving (live preview). */
  async preview(baselineId: string, changeset: Changeset, signal?: AbortSignal): Promise<PackageResult> {
    return this.packageRequest('POST', `/api/v1/networks/${enc(baselineId)}/preview`, { changeset }, signal);
  }

  /** Read-only scenario behind a share token (no token in the response). */
  async getShared(token: string, signal?: AbortSignal): Promise<Scenario> {
    return toScenario(await this.json('GET', `/api/v1/shared/${enc(token)}`, undefined, signal));
  }

  async getSharedPackage(token: string, signal?: AbortSignal): Promise<PackageResult> {
    return this.packageRequest('GET', `/api/v1/shared/${enc(token)}/package`, undefined, signal);
  }

  async listRuns(scenarioId: string, signal?: AbortSignal): Promise<RunSummary[]> {
    const list = await this.json<RunSummary[]>('GET', `/api/v1/scenarios/${enc(scenarioId)}/runs`, undefined, signal);
    return Array.isArray(list) ? list : [];
  }

  private async packageRequest(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<PackageResult> {
    const response = await this.send(method, path, body, signal);
    if (!response.ok) await this.fail(response);
    const issues = parseIssueHeaders(response.headers.get(ISSUE_COUNT_HEADER), response.headers.get(ISSUE_LIST_HEADER));
    return { pkg: (await response.json()) as unknown, issues };
  }

  private send(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return this.fetchFn(`${this.baseUrl}${path}`, { method, signal, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  private async json<T = unknown>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.send(method, path, body, signal);
    if (!response.ok) await this.fail(response);
    return (await response.json()) as T;
  }

  private async fail(response: Response): Promise<never> {
    let problem: { title?: string; detail?: string; issues?: unknown } = {};
    try {
      problem = (await response.json()) as typeof problem;
    } catch {
      // Not JSON: keep the status text.
    }
    const message = problem.detail ?? problem.title ?? (response.statusText || `HTTP ${response.status}`);
    if (response.status === 422 && Array.isArray(problem.issues)) throw new ChangesetRejectedError(message, toIssues(problem.issues));
    throw new ApiError(response.status, message);
  }
}

/** Download URLs of the export endpoints (#75). */
export const exportUrls = {
  networkGeoJson: (scenarioId: string) => `/api/v1/scenarios/${enc(scenarioId)}/export/network.geojson`,
  runLinksCsv: (runId: string) => `/api/v1/runs/${enc(runId)}/export/links.csv`,
  runLinksGeoJson: (runId: string) => `/api/v1/runs/${enc(runId)}/export/links.geojson`,
  runSummaryCsv: (runId: string) => `/api/v1/runs/${enc(runId)}/export/summary.csv`,
};
