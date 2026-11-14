import type { Builtins } from '../builtins';
import { resetProfiles, setEntry, setProfile } from '../edits';
import type { DemandModel } from '../model';
import { effectiveProfile, type BoundaryEntry } from '../network';
import { CurveSelect, fmtVph, NumberField } from './fields';

export interface EntriesTabProps {
  model: DemandModel;
  onChange: (next: DemandModel) => void;
  /** Entry nodes of the network (empty without a package). */
  entries: BoundaryEntry[];
  builtins: Builtins;
  curveNames: readonly string[];
  selected: string | null;
  onSelect: (node: string | null) => void;
  invalid: ReadonlySet<string>;
  readOnly: boolean;
}

const SOURCE: Record<BoundaryEntry['source'], string> = {
  entry: 'override',
  legacy: 'legacy demand',
  uniform: 'defaultDemand',
  profile: 'road class',
  off: 'off',
};

/** Boundary entries (#111): per-node overrides or the road-class default, and the road-class profile table. */
export function EntriesTab({ model, onChange, entries, builtins, curveNames, selected, onSelect, invalid, readOnly }: EntriesTabProps) {
  const known = new Set(entries.map((e) => e.node));
  const orphans = Object.keys(model.entries).filter((n) => !known.has(n));
  const forced = typeof model.rest.demandCurve === 'string' ? model.rest.demandCurve : null;
  const classes = Object.keys(builtins.roadClassProfiles);

  return (
    <div className="demand-tab">
      {forced && (
        <p className="small notice">
          This scenario forces curve <strong>{forced}</strong> for all boundary traffic (<code>demandCurve</code>).
        </p>
      )}
      <h3>Entry nodes</h3>
      {entries.length === 0 && orphans.length === 0 ? (
        <p className="muted small">No boundary entries in this network.</p>
      ) : (
        <div className="demand-scroll">
          <table className="demand-table">
            <thead>
              <tr>
                <th scope="col">Node</th>
                <th scope="col">Roads</th>
                <th scope="col">Override</th>
                <th scope="col" className="num">
                  veh/h
                </th>
                <th scope="col">Curve</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const o = model.entries[e.node];
                return (
                  <tr key={e.node} className={invalid.has(`entries.${e.node}`) ? 'invalid' : undefined} aria-selected={selected === e.node} onClick={() => onSelect(e.node)}>
                    <th scope="row">{e.node}</th>
                    <td className="small">{e.links.map((l) => `${l.roadClass} ×${l.lanes}`).join(', ')}</td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Override demand of ${e.node}`}
                        checked={o !== undefined}
                        disabled={readOnly}
                        onChange={(ev) => onChange(setEntry(model, e.node, ev.target.checked ? { vph: Math.round(e.defaultVph), curve: e.defaultCurve ?? undefined } : null))}
                      />
                    </td>
                    <td className="num">
                      {o ? (
                        <NumberField label={`Vehicles per hour at ${e.node}`} value={o.vph} disabled={readOnly} onChange={(vph) => onChange(setEntry(model, e.node, { ...o, vph }))} />
                      ) : (
                        <span title={SOURCE[e.source]}>{fmtVph(e.vph)}</span>
                      )}
                    </td>
                    <td>
                      {o ? (
                        <CurveSelect label={`Curve at ${e.node}`} value={o.curve} names={curveNames} disabled={readOnly} onChange={(curve) => onChange(setEntry(model, e.node, { ...o, curve }))} />
                      ) : (
                        <span className="muted">{e.curve ?? 'constant'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {orphans.map((node) => (
                <tr key={node} className="invalid">
                  <th scope="row">{node}</th>
                  <td className="small error">not an entry node</td>
                  <td colSpan={3}>
                    {!readOnly && (
                      <button type="button" onClick={() => onChange(setEntry(model, node, null))}>
                        Remove override
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Road-class profiles</h3>
      <p className="muted small">Default entry volume = volume per lane × lanes of the entry roads, at curve factor 1.</p>
      <div className="demand-scroll">
        <table className="demand-table">
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col" className="num">
                veh/h/lane
              </th>
              <th scope="col">Curve</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((cls) => {
              const builtin = builtins.roadClassProfiles[cls]!;
              const p = effectiveProfile(model, builtins, cls);
              const changed = cls in model.profiles;
              return (
                <tr key={cls} className={invalid.has(`profiles.${cls}`) ? 'invalid' : changed ? 'changed' : undefined}>
                  <th scope="row">{cls}</th>
                  <td className="num">
                    <NumberField
                      label={`Volume per lane of ${cls}`}
                      value={p.volumePerLane}
                      placeholder={String(builtin.volumePerLane)}
                      disabled={readOnly}
                      onChange={(volumePerLane) => onChange(setProfile(model, cls, { volumePerLane }, builtin))}
                    />
                  </td>
                  <td>
                    <CurveSelect label={`Curve of ${cls}`} value={p.curve} names={curveNames} none={null} disabled={readOnly} onChange={(curve) => onChange(setProfile(model, cls, { curve }, builtin))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!readOnly && Object.keys(model.profiles).length > 0 && (
        <div className="buttons">
          <button type="button" onClick={() => onChange(resetProfiles(model))}>
            Reset profiles to built-in defaults
          </button>
        </div>
      )}
    </div>
  );
}
