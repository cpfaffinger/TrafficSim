import { useState } from 'react';
import { HOUR, isBuiltinCurve, newHourlyCurve, resolveCurve, type TimeCurve } from '../curves';
import { curveUsage, freeCurveName, renameCurve, setCurve } from '../edits';
import { formatClock, type DemandModel } from '../model';
import { CurveChart } from './CurveChart';
import { NumberField } from './fields';

export interface CurvesTabProps {
  model: DemandModel;
  onChange: (next: DemandModel) => void;
  curveNames: readonly string[];
  window: { start: number; duration: number };
  invalid: ReadonlySet<string>;
  readOnly: boolean;
}

const isHourly = (c: TimeCurve) => c.interval === HOUR && c.factors.length === 24;

/** Time-of-day curves: chart of any curve, custom curves with 24 hourly factors. */
export function CurvesTab({ model, onChange, curveNames, window, invalid, readOnly }: CurvesTabProps) {
  const [shown, setShown] = useState<string>(Object.keys(model.curves)[0] ?? 'weekday');
  const curve = resolveCurve(shown, model.curves);
  const custom = shown in model.curves ? model.curves[shown]! : null;
  const used = curveUsage(model, shown);

  const create = () => {
    const name = freeCurveName(model);
    onChange(setCurve(model, name, newHourlyCurve(curve)));
    setShown(name);
  };

  return (
    <div className="demand-tab">
      <div className="demand-fields">
        <label>
          Curve
          <select value={shown} onChange={(e) => setShown(e.target.value)}>
            {curveNames.map((n) => (
              <option key={n} value={n}>
                {n}
                {isBuiltinCurve(n) && !(n in model.curves) ? ' (built-in)' : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">
          used {used} time{used === 1 ? '' : 's'} in this scenario
        </span>
      </div>
      <CurveChart name={shown} curve={curve} window={window} />
      <p className="muted small">Mean factor per hour; the shaded hours are the scenario window. Peak hour = factor 1 = the configured veh/h.</p>

      {custom && (
        <div className={invalid.has(`curves.${shown}`) ? 'custom-curve invalid' : 'custom-curve'}>
          <RenameField
            key={shown}
            name={shown}
            taken={(n) => n !== shown && (n in model.curves || isBuiltinCurve(n))}
            disabled={readOnly}
            onRename={(to) => {
              onChange(renameCurve(model, shown, to));
              setShown(to);
            }}
          />
          {isHourly(custom) ? (
            <div className="factor-grid">
              {custom.factors.map((f, h) => (
                <label key={h}>
                  <span className="muted small">{formatClock(h * HOUR)}</span>
                  <NumberField
                    label={`Factor ${formatClock(h * HOUR)}`}
                    value={f}
                    step={0.05}
                    disabled={readOnly}
                    onChange={(v) => onChange(setCurve(model, shown, { ...custom, factors: custom.factors.map((x, i) => (i === h ? v : x)) }))}
                  />
                </label>
              ))}
            </div>
          ) : (
            <p className="small">
              {custom.factors.length} factors every {custom.interval} s.{' '}
              {!readOnly && (
                <button type="button" onClick={() => onChange(setCurve(model, shown, newHourlyCurve(custom)))}>
                  Convert to 24 hourly factors
                </button>
              )}
            </p>
          )}
          {!readOnly && (
            <div className="buttons">
              <button
                type="button"
                className="danger"
                disabled={used > 0}
                title={used > 0 ? 'Still in use' : undefined}
                onClick={() => {
                  onChange(setCurve(model, shown, null));
                  setShown('weekday');
                }}
              >
                Delete curve
              </button>
            </div>
          )}
        </div>
      )}
      {!readOnly && (
        <div className="buttons">
          <button type="button" onClick={create}>
            New custom curve from “{shown}”
          </button>
        </div>
      )}
    </div>
  );
}

interface RenameFieldProps {
  name: string;
  taken: (name: string) => boolean;
  onRename: (name: string) => void;
  disabled: boolean;
}

/** Name input that renames on blur / Enter when the new name is free. */
function RenameField({ name, taken, onRename, disabled }: RenameFieldProps) {
  const [text, setText] = useState(name);
  const next = text.trim();
  const problem = !next || /\s/.test(next) ? 'Use a name without spaces.' : taken(next) ? 'This name is taken.' : null;
  const commit = () => {
    if (!problem && next !== name) onRename(next);
  };
  return (
    <div className="field">
      <label>
        Name
        <input
          type="text"
          value={text}
          disabled={disabled}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      </label>
      {problem && <span className="error small">{problem}</span>}
    </div>
  );
}
