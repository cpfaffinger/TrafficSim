import type { Scenario, ScenarioInput } from '../api/scenarioClient';

/** Scenario settings form (#72): text fields ↔ validated API input. */
export interface ScenarioForm {
  name: string;
  seed: string;
  durationMinutes: string;
  /** Opaque demand JSON (edited as text until Phase 5 adds a demand editor). */
  demand: string;
}

export const MAX_DURATION_MINUTES = 24 * 60;

export function formOf(s: Scenario): ScenarioForm {
  return {
    name: s.name,
    seed: String(s.seed),
    durationMinutes: String(Math.round((s.durationSeconds / 60) * 100) / 100),
    demand: s.demand === null || s.demand === undefined ? '' : JSON.stringify(s.demand, null, 2),
  };
}

export type FormResult = { ok: true; input: ScenarioInput } | { ok: false; errors: Partial<Record<keyof ScenarioForm, string>> };

export function validateForm(form: ScenarioForm): FormResult {
  const errors: Partial<Record<keyof ScenarioForm, string>> = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > 120) errors.name = 'At most 120 characters.';
  const seed = Number(form.seed);
  if (!/^-?\d+$/.test(form.seed.trim()) || !Number.isSafeInteger(seed)) errors.seed = 'The seed is a whole number.';
  const minutes = Number(form.durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_DURATION_MINUTES) errors.durationMinutes = `Between 0 and ${MAX_DURATION_MINUTES} minutes.`;
  let demand: unknown = null;
  if (form.demand.trim()) {
    try {
      demand = JSON.parse(form.demand) as unknown;
    } catch {
      errors.demand = 'Demand must be valid JSON (or empty).';
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { name, seed, durationSeconds: Math.round(minutes * 60), ...(demand !== null ? { demand } : {}) } };
}

/** Default name for a new scenario: "Variant n" with the first free n. */
export function nextScenarioName(existing: readonly { name: string }[], base = 'Variant'): string {
  const names = new Set(existing.map((s) => s.name));
  for (let n = existing.length + 1; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}
