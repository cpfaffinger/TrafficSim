import { describe, expect, it } from 'vitest';
import type { Scenario } from '../api/scenarioClient';
import { formOf, nextScenarioName, validateForm } from './scenarioForm';

const scenario: Scenario = {
  id: 's1',
  name: 'Base',
  baselineId: 'b1',
  parentId: null,
  changeset: [],
  demand: { zones: 2 },
  seed: 42,
  durationSeconds: 5400,
  shareToken: null,
  createdAt: '',
  updatedAt: '',
};

describe('scenario form (#72)', () => {
  it('round-trips scenario settings', () => {
    const form = formOf(scenario);
    expect(form).toEqual({ name: 'Base', seed: '42', durationMinutes: '90', demand: '{\n  "zones": 2\n}' });
    expect(validateForm(form)).toEqual({ ok: true, input: { name: 'Base', seed: 42, durationSeconds: 5400, demand: { zones: 2 } } });
    expect(formOf({ ...scenario, demand: null }).demand).toBe('');
    expect(validateForm({ ...form, demand: ' ' })).toEqual({ ok: true, input: { name: 'Base', seed: 42, durationSeconds: 5400 } });
  });

  it('reports invalid fields', () => {
    const bad = validateForm({ name: ' ', seed: '1.5', durationMinutes: '0', demand: '{' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(['demand', 'durationMinutes', 'name', 'seed']);
    const long = validateForm({ ...formOf(scenario), name: 'x'.repeat(121), durationMinutes: '2000' });
    expect(!long.ok && long.errors).toEqual({ name: 'At most 120 characters.', durationMinutes: 'Between 0 and 1440 minutes.' });
  });

  it('proposes free variant names', () => {
    expect(nextScenarioName([])).toBe('Variant 1');
    expect(nextScenarioName([{ name: 'Variant 2' }, { name: 'x' }])).toBe('Variant 3');
    expect(nextScenarioName([{ name: 'Variant 2' }])).toBe('Variant 3');
  });
});
