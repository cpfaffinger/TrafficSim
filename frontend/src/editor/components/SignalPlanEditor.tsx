import { useMemo, useState } from 'react';
import type { PackageIndex } from '../../network/inspect';
import { armLabel } from '../movements';
import type { EditResult } from '../ops';
import {
  addPhase,
  draftFromPackage,
  fitGreens,
  MAX_CYCLE,
  MIN_CYCLE,
  minimumCycle,
  phaseTimeline,
  removePhase,
  signalApproaches,
  signalPlanEdit,
  validatePlan,
  type SignalPlanDraft,
} from '../signalPlan';

export interface SignalPlanEditorProps {
  index: PackageIndex;
  nodeId: string;
  apply: (build: () => EditResult) => boolean;
}

const W = 300;
const ROW = 16;

/** Cycle, offset, phase greens, approach → phase, with a timeline of one cycle (#68). */
export function SignalPlanEditor({ index, nodeId, apply }: SignalPlanEditorProps) {
  const [draft, setDraft] = useState<SignalPlanDraft>(() => draftFromPackage(index, nodeId));
  const approaches = useMemo(() => signalApproaches(index, nodeId), [index, nodeId]);
  const problems = validatePlan(draft);
  const timeline = phaseTimeline(draft);
  const x = (t: number) => Math.round((t / Math.max(draft.cycle, 1)) * W * 10) / 10;
  const setNumber = (key: 'cycle' | 'offset') => (v: string) => setDraft((d) => ({ ...d, [key]: Number(v) }));
  const osmId = index.nodes.get(nodeId)?.osmId ?? null;

  return (
    <div className="signal-plan">
      <div className="field-row">
        <label htmlFor="cycle">Cycle (s)</label>
        <input id="cycle" type="number" min={MIN_CYCLE} max={MAX_CYCLE} value={draft.cycle} onChange={(e) => setNumber('cycle')(e.target.value)} />
        <label htmlFor="offset">Offset (s)</label>
        <input id="offset" type="number" min={0} max={draft.cycle - 1} value={draft.offset} onChange={(e) => setNumber('offset')(e.target.value)} />
      </div>
      <table className="phase-table">
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Green (s)</th>
            <th scope="col">
              <span className="visually-hidden">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.phaseGreen.map((g, p) => (
            <tr key={p}>
              <th scope="row">{p + 1}</th>
              <td>
                <input
                  type="number"
                  min={3}
                  aria-label={`Green time of phase ${p + 1}`}
                  value={g}
                  onChange={(e) => setDraft((d) => ({ ...d, phaseGreen: d.phaseGreen.map((v, i) => (i === p ? Number(e.target.value) : v)) }))}
                />
              </td>
              <td>
                <button type="button" className="glyph" aria-label={`Remove phase ${p + 1}`} disabled={draft.phaseGreen.length <= 1} onClick={() => setDraft((d) => removePhase(d, p))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons">
        <button type="button" onClick={() => setDraft(addPhase)}>
          + Phase
        </button>
        <button type="button" onClick={() => setDraft(fitGreens)} title="Scale greens to fill the cycle">
          Fit greens to cycle
        </button>
      </div>
      <p className="muted small">
        Needs {minimumCycle(draft.phaseGreen)} s incl. 3 s amber and 2 s all-red per phase.
      </p>

      <svg className="timeline" viewBox={`0 0 ${W} ${timeline.length * ROW + 14}`} role="img" aria-label={`Timeline of one ${draft.cycle} s cycle`}>
        {timeline.map((t) => (
          <g key={t.phase} transform={`translate(0 ${t.phase * ROW})`}>
            <rect x={0} y={2} width={W} height={ROW - 4} className="sig-red" />
            <rect x={x(t.greenStart)} y={2} width={Math.max(0, x(t.greenEnd) - x(t.greenStart))} height={ROW - 4} className="sig-green" />
            <rect x={x(t.greenEnd)} y={2} width={Math.max(0, x(t.amberEnd) - x(t.greenEnd))} height={ROW - 4} className="sig-amber" />
            <text x={3} y={ROW - 5} className="sig-label">
              {t.phase + 1}
            </text>
          </g>
        ))}
        <text x={0} y={timeline.length * ROW + 12} className="sig-axis">
          0 s
        </text>
        <text x={W} y={timeline.length * ROW + 12} textAnchor="end" className="sig-axis">
          {draft.cycle} s
        </text>
      </svg>

      <table className="phase-table">
        <thead>
          <tr>
            <th scope="col">Approach</th>
            <th scope="col">Phase</th>
          </tr>
        </thead>
        <tbody>
          {approaches.map((a) => (
            <tr key={a.link.id}>
              <td>{armLabel(a.link, true)}</td>
              <td>
                <select
                  aria-label={`Phase of the approach ${armLabel(a.link, true)}`}
                  value={draft.approachPhase[a.link.id] ?? 0}
                  disabled={a.neighbour === null}
                  onChange={(e) => setDraft((d) => ({ ...d, approachPhase: { ...d.approachPhase, [a.link.id]: Number(e.target.value) } }))}
                >
                  {draft.phaseGreen.map((_, p) => (
                    <option key={p} value={p}>
                      {p + 1}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {problems.length > 0 && (
        <ul className="error small">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <button type="button" className="primary" disabled={problems.length > 0} onClick={() => apply(() => signalPlanEdit(osmId, draft, approaches))}>
        Apply signal plan
      </button>
    </div>
  );
}
