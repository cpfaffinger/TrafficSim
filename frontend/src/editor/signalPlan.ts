import type { PackageIndex } from '../network/inspect';
import type { Link } from '../network/types';
import { EditError, type EditResult } from './ops';

/**
 * Fixed-time signal plans (#68). Phases run in order, each followed by amber and all-red; this
 * mirrors the compiler (`BuildSignalPlans`), so the timeline preview shows what will be simulated.
 */
export const AMBER_SECONDS = 3;
export const ALL_RED_SECONDS = 2;
export const MIN_CYCLE = 20;
export const MAX_CYCLE = 240;
export const MIN_GREEN = 3;
export const MAX_PHASES = 6;

export interface SignalPlanDraft {
  cycle: number;
  offset: number;
  phaseGreen: number[];
  /** Phase per approach link id (compiled ids; converted to OSM neighbour ids when saved). */
  approachPhase: Record<string, number>;
}

export interface SignalApproach {
  link: Link;
  /** OSM node before the junction on the approach, the key of `approachPhase` in the edit. */
  neighbour: number | null;
}

export interface PhaseTiming {
  phase: number;
  greenStart: number;
  greenEnd: number;
  amberEnd: number;
  /** End of the all-red clearance. */
  clearEnd: number;
}

export type SignalState = 'green' | 'amber' | 'red';

/** Incoming links with movements at the node (the compiler's signal approaches). */
export function signalApproaches(index: PackageIndex, nodeId: string): SignalApproach[] {
  const fromLinks = new Set(index.pkg.connectors.filter((c) => c.node === nodeId).map((c) => c.fromLink));
  return index.pkg.links
    .filter((l) => l.to === nodeId && fromLinks.has(l.id))
    .map((link) => ({ link, neighbour: link.osmBeforeTo ?? null }));
}

const groupIndex = (groupId: string | null | undefined) => {
  const m = /:g(\d+)$/.exec(groupId ?? '');
  return m ? Number(m[1]) : 0;
};

/** The plan currently compiled for the node, or a two-phase default for nodes without signals. */
export function draftFromPackage(index: PackageIndex, nodeId: string): SignalPlanDraft {
  const signal = index.signals.get(nodeId);
  const approaches = signalApproaches(index, nodeId);
  const approachPhase: Record<string, number> = {};
  if (!signal) {
    approaches.forEach((a, i) => (approachPhase[a.link.id] = i % 2));
    return { cycle: 90, offset: 0, phaseGreen: [40, 40], approachPhase };
  }
  const groups = [...signal.groups].sort((a, b) => groupIndex(a.id) - groupIndex(b.id));
  const phaseGreen = groups.map((g) => Math.max(MIN_GREEN, Math.round(g.green.reduce((s, [a, b]) => s + (b - a), 0))));
  for (const a of approaches) {
    const c = index.pkg.connectors.find((x) => x.node === nodeId && x.fromLink === a.link.id);
    approachPhase[a.link.id] = Math.min(groupIndex(c?.signalGroup), Math.max(0, phaseGreen.length - 1));
  }
  return { cycle: signal.cycle, offset: signal.offset, phaseGreen: phaseGreen.length ? phaseGreen : [40], approachPhase };
}

/** Shortest cycle that fits all greens with amber and all-red clearances. */
export function minimumCycle(phaseGreen: readonly number[]): number {
  return phaseGreen.reduce((s, g) => s + g, 0) + phaseGreen.length * (AMBER_SECONDS + ALL_RED_SECONDS);
}

export function phaseTimeline(draft: SignalPlanDraft): PhaseTiming[] {
  let start = 0;
  return draft.phaseGreen.map((g, phase) => {
    const greenEnd = Math.min(draft.cycle, start + g);
    const t: PhaseTiming = {
      phase,
      greenStart: Math.min(start, draft.cycle),
      greenEnd,
      amberEnd: Math.min(draft.cycle, greenEnd + AMBER_SECONDS),
      clearEnd: Math.min(draft.cycle, greenEnd + AMBER_SECONDS + ALL_RED_SECONDS),
    };
    start += g + AMBER_SECONDS + ALL_RED_SECONDS;
    return t;
  });
}

/** State of a phase at time `t` (seconds since the cycle start, offset applied). */
export function stateAt(draft: SignalPlanDraft, phase: number, t: number): SignalState {
  const timing = phaseTimeline(draft)[phase];
  if (!timing) return 'red';
  const local = (((t - draft.offset) % draft.cycle) + draft.cycle) % draft.cycle;
  if (local >= timing.greenStart && local < timing.greenEnd) return 'green';
  if (local >= timing.greenEnd && local < timing.amberEnd) return 'amber';
  return 'red';
}

export function validatePlan(draft: SignalPlanDraft): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(draft.cycle) || draft.cycle < MIN_CYCLE || draft.cycle > MAX_CYCLE) problems.push(`Cycle must be ${MIN_CYCLE}–${MAX_CYCLE} s.`);
  if (draft.phaseGreen.length < 1 || draft.phaseGreen.length > MAX_PHASES) problems.push(`A plan has 1–${MAX_PHASES} phases.`);
  if (draft.phaseGreen.some((g) => !Number.isFinite(g) || g < MIN_GREEN)) problems.push(`Each phase needs at least ${MIN_GREEN} s green.`);
  if (!Number.isFinite(draft.offset) || draft.offset < 0 || draft.offset >= draft.cycle) problems.push('Offset must be between 0 and the cycle time.');
  const min = minimumCycle(draft.phaseGreen);
  if (problems.length === 0 && min > draft.cycle) problems.push(`Greens and clearances need ${min} s; extend the cycle or shorten greens.`);
  if (Object.values(draft.approachPhase).some((p) => p < 0 || p >= draft.phaseGreen.length)) problems.push('Every approach must use an existing phase.');
  return problems;
}

/** Scales greens so the plan fills the cycle exactly (e.g. after changing the cycle time). */
export function fitGreens(draft: SignalPlanDraft): SignalPlanDraft {
  const available = draft.cycle - draft.phaseGreen.length * (AMBER_SECONDS + ALL_RED_SECONDS);
  const total = draft.phaseGreen.reduce((s, g) => s + g, 0) || 1;
  const phaseGreen = draft.phaseGreen.map((g) => Math.max(MIN_GREEN, Math.floor((g / total) * available)));
  return { ...draft, phaseGreen };
}

export function addPhase(draft: SignalPlanDraft): SignalPlanDraft {
  if (draft.phaseGreen.length >= MAX_PHASES) return draft;
  return { ...draft, phaseGreen: [...draft.phaseGreen, 10] };
}

/** Removes a phase; approaches on it move to the previous phase, later phases shift down. */
export function removePhase(draft: SignalPlanDraft, phase: number): SignalPlanDraft {
  if (draft.phaseGreen.length <= 1) return draft;
  const approachPhase: Record<string, number> = {};
  for (const [k, p] of Object.entries(draft.approachPhase)) approachPhase[k] = p > phase ? p - 1 : p === phase ? Math.max(0, phase - 1) : p;
  return { ...draft, phaseGreen: draft.phaseGreen.filter((_, i) => i !== phase), approachPhase };
}

/** `set_signal_plan` edit; approach phases are keyed by the approach's OSM neighbour node. */
export function signalPlanEdit(nodeOsmId: number | null, draft: SignalPlanDraft, approaches: readonly SignalApproach[]): EditResult {
  if (nodeOsmId === null) throw new EditError('This junction has no OpenStreetMap node and cannot be retimed.');
  const problems = validatePlan(draft);
  if (problems.length) throw new EditError(problems.join(' '));
  const approachPhase: Record<string, number> = {};
  for (const a of approaches) {
    const phase = draft.approachPhase[a.link.id];
    if (a.neighbour !== null && phase !== undefined) approachPhase[String(a.neighbour)] = phase;
  }
  return {
    label: `Signal plan: ${draft.cycle} s cycle, ${draft.phaseGreen.length} phases`,
    ops: [
      {
        op: 'set_signal_plan',
        nodeId: nodeOsmId,
        cycle: draft.cycle,
        offset: draft.offset,
        phaseGreen: [...draft.phaseGreen],
        approachPhase: Object.keys(approachPhase).length ? approachPhase : null,
      },
    ],
  };
}
