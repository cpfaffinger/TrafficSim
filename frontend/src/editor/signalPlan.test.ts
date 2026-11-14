import { describe, expect, it } from 'vitest';
import { PackageIndex } from '../network/inspect';
import { editorNetwork } from '../test/editorNetwork';
import { EditError } from './ops';
import {
  addPhase,
  draftFromPackage,
  fitGreens,
  minimumCycle,
  phaseTimeline,
  removePhase,
  signalApproaches,
  signalPlanEdit,
  stateAt,
  validatePlan,
  type SignalPlanDraft,
} from './signalPlan';

const signalised = new PackageIndex(editorNetwork({ signalised: true }));
const plain = new PackageIndex(editorNetwork());

describe('signal plans (#68)', () => {
  it('reads the compiled plan and approach phases', () => {
    const draft = draftFromPackage(signalised, 'n0');
    expect(draft).toEqual({ cycle: 90, offset: 0, phaseGreen: [40, 40], approachPhase: { l0: 0, l3: 0, l4: 1, l6: 1 } });
    expect(signalApproaches(signalised, 'n0').map((a) => [a.link.id, a.neighbour])).toEqual([
      ['l0', 202],
      ['l3', 301],
      ['l4', 401],
      ['l6', 501],
    ]);
  });

  it('proposes a two-phase default for unsignalised junctions', () => {
    expect(draftFromPackage(plain, 'n0')).toEqual({ cycle: 90, offset: 0, phaseGreen: [40, 40], approachPhase: { l0: 0, l3: 1, l4: 0, l6: 1 } });
  });

  it('lays out phases with amber and all-red like the compiler', () => {
    const draft: SignalPlanDraft = { cycle: 90, offset: 0, phaseGreen: [40, 35], approachPhase: {} };
    expect(phaseTimeline(draft)).toEqual([
      { phase: 0, greenStart: 0, greenEnd: 40, amberEnd: 43, clearEnd: 45 },
      { phase: 1, greenStart: 45, greenEnd: 80, amberEnd: 83, clearEnd: 85 },
    ]);
    expect(minimumCycle([40, 35])).toBe(85);
    expect(stateAt(draft, 0, 10)).toBe('green');
    expect(stateAt(draft, 0, 41)).toBe('amber');
    expect(stateAt(draft, 0, 60)).toBe('red');
    expect(stateAt({ ...draft, offset: 20 }, 0, 10)).toBe('red');
    expect(stateAt({ ...draft, offset: 20 }, 0, 25)).toBe('green');
    expect(stateAt(draft, 4, 10)).toBe('red');
  });

  it('validates cycle, greens, offset and approaches', () => {
    const ok: SignalPlanDraft = { cycle: 90, offset: 0, phaseGreen: [40, 35], approachPhase: { l0: 1 } };
    expect(validatePlan(ok)).toEqual([]);
    expect(validatePlan({ ...ok, cycle: 300 })[0]).toMatch(/Cycle/);
    expect(validatePlan({ ...ok, phaseGreen: [2, 40] })[0]).toMatch(/at least 3 s/);
    expect(validatePlan({ ...ok, phaseGreen: [] })[0]).toMatch(/1–6 phases/);
    expect(validatePlan({ ...ok, offset: 95 })[0]).toMatch(/Offset/);
    expect(validatePlan({ ...ok, cycle: 60 })[0]).toMatch(/need 85 s/);
    expect(validatePlan({ ...ok, approachPhase: { l0: 2 } })[0]).toMatch(/existing phase/);
  });

  it('fits greens to the cycle and edits phases', () => {
    const d: SignalPlanDraft = { cycle: 60, offset: 0, phaseGreen: [40, 40], approachPhase: { a: 0, b: 1, c: 2 } };
    expect(fitGreens(d).phaseGreen).toEqual([25, 25]);
    expect(addPhase(d).phaseGreen).toEqual([40, 40, 10]);
    expect(addPhase({ ...d, phaseGreen: [5, 5, 5, 5, 5, 5] }).phaseGreen).toHaveLength(6);
    const removed = removePhase({ ...d, phaseGreen: [10, 10, 10] }, 1);
    expect(removed.phaseGreen).toEqual([10, 10]);
    expect(removed.approachPhase).toEqual({ a: 0, b: 0, c: 1 });
    expect(removePhase({ ...d, phaseGreen: [10] }, 0).phaseGreen).toEqual([10]);
  });

  it('builds the edit with approach phases keyed by OSM neighbour', () => {
    const draft = { ...draftFromPackage(signalised, 'n0'), phaseGreen: [45, 30] };
    const r = signalPlanEdit(100, draft, signalApproaches(signalised, 'n0'));
    expect(r.ops).toEqual([
      { op: 'set_signal_plan', nodeId: 100, cycle: 90, offset: 0, phaseGreen: [45, 30], approachPhase: { '202': 0, '301': 0, '401': 1, '501': 1 } },
    ]);
    expect(signalPlanEdit(100, { ...draft, approachPhase: {} }, []).ops[0]).toMatchObject({ approachPhase: null });
    expect(() => signalPlanEdit(null, draft, [])).toThrow(EditError);
    expect(() => signalPlanEdit(100, { ...draft, cycle: 10 }, [])).toThrow(/Cycle/);
  });
});
