import { setStartTime } from '../edits';
import { formatClock, parseClock, type DemandModel } from '../model';
import { autoEntries } from '../network';
import { PROCESS_LABELS, type ProcessTotal } from '../totals';
import { fmtVph } from './fields';

export interface OverviewTabProps {
  model: DemandModel;
  durationSeconds: number;
  totals: ProcessTotal[];
  readOnly: boolean;
  onChange: (next: DemandModel) => void;
}

const duration = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};

/** Start time, scenario window and generated volumes per process kind. */
export function OverviewTab({ model, durationSeconds, totals, readOnly, onChange }: OverviewTabProps) {
  const start = model.startTimeOfDay;
  const valid = Number.isFinite(start);
  const sum = (k: 'peakVph' | 'meanVph') => totals.reduce((a, t) => a + t[k], 0);
  return (
    <div className="demand-tab">
      <div className="demand-fields">
        <label>
          Start time
          <input
            type="time"
            step={60}
            value={valid ? formatClock(start).slice(0, 5) : ''}
            disabled={readOnly}
            aria-invalid={valid ? undefined : true}
            onChange={(e) => onChange(setStartTime(model, parseClock(e.target.value) ?? NaN))}
          />
        </label>
        <span>
          Duration <strong>{duration(durationSeconds)}</strong>
          {valid && (
            <span className="muted">
              {' '}
              ({formatClock(start)}–{formatClock(start + durationSeconds)})
            </span>
          )}
        </span>
      </div>
      <p className="muted small">The duration is a scenario setting. Rates are vehicles per hour before the simulation panel’s demand level.</p>
      <table className="demand-table">
        <thead>
          <tr>
            <th scope="col">Process</th>
            <th scope="col" className="num">
              Sources
            </th>
            <th scope="col" className="num">
              Peak veh/h
            </th>
            <th scope="col" className="num">
              Mean veh/h in window
            </th>
          </tr>
        </thead>
        <tbody>
          {totals.map((t) => (
            <tr key={t.kind}>
              <th scope="row">{PROCESS_LABELS[t.kind]}</th>
              <td className="num">{t.count}</td>
              <td className="num">{fmtVph(t.peakVph)}</td>
              <td className="num">{fmtVph(t.meanVph)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td />
            <td className="num">{fmtVph(sum('peakVph'))}</td>
            <td className="num">{fmtVph(sum('meanVph'))}</td>
          </tr>
        </tfoot>
      </table>
      <label className="check">
        <input
          type="checkbox"
          checked={autoEntries(model)}
          disabled={readOnly}
          onChange={(e) => onChange({ ...model, rest: { ...model.rest, autoEntries: e.target.checked } })}
        />
        Road-class traffic at all boundary entries (through traffic)
      </label>
      <p className="muted small">
        {model.zones.length} zone{model.zones.length === 1 ? '' : 's'} · {model.od.length} OD entr{model.od.length === 1 ? 'y' : 'ies'}
        {model.rest.autoZones === true ? ' · residential trip generation on' : ''}
      </p>
    </div>
  );
}
