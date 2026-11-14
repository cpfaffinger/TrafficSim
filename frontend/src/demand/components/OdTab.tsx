import { Fragment, useState } from 'react';
import { resolveCurve } from '../curves';
import { addOd, newOdEntry, removeOd, updateOd } from '../edits';
import type { DemandModel, OdEntry } from '../model';
import { odRows, toggleSort, type OdSortKey, type OdView } from '../odTable';
import { CurveChart } from './CurveChart';
import { CurveSelect, fmtVph, NumberField } from './fields';
import { MixEditor } from './MixEditor';

export interface OdTabProps {
  model: DemandModel;
  onChange: (next: DemandModel) => void;
  view: OdView;
  onView: (view: OdView) => void;
  selected: number | null;
  onSelect: (index: number | null) => void;
  curveNames: readonly string[];
  mixNames: { vehicle: string[]; driver: string[] };
  /** Paths (`od.<i>`) with validation problems. */
  invalid: ReadonlySet<string>;
  window: { start: number; duration: number };
  readOnly: boolean;
}

const PAGE = 100;

const COLUMNS: { key: OdSortKey; label: string; num?: boolean }[] = [
  { key: 'index', label: '#' },
  { key: 'from', label: 'From' },
  { key: 'to', label: 'To' },
  { key: 'vph', label: 'veh/h', num: true },
  { key: 'curve', label: 'Curve' },
];

/** OD matrix (#53): filter, sort, edit rates and curves, add and remove entries; selected pairs show on the map. */
export function OdTab({ model, onChange, view, onView, selected, onSelect, curveNames, mixNames, invalid, window, readOnly }: OdTabProps) {
  const [limit, setLimit] = useState(PAGE);
  const rows = odRows(model.od, view);
  const zoneIds = model.zones.map((z) => z.id);
  const sum = rows.reduce((a, i) => a + (Number.isFinite(model.od[i]!.vph) ? model.od[i]!.vph : 0), 0);
  const edit = (i: number, patch: Partial<OdEntry>) => onChange(updateOd(model, i, patch));
  const zoneSelect = (i: number, key: 'from' | 'to') => {
    const value = model.od[i]![key];
    const options = zoneIds.includes(value) ? zoneIds : [...zoneIds, value];
    return (
      <select aria-label={`${key === 'from' ? 'Origin' : 'Destination'} of entry ${i + 1}`} value={value} disabled={readOnly} onChange={(e) => edit(i, { [key]: e.target.value })}>
        {options.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </select>
    );
  };
  const add = () => {
    onChange(addOd(model, newOdEntry(model, view.zone ?? undefined)));
    onSelect(model.od.length);
  };
  const remove = (i: number) => {
    onChange(removeOd(model, i));
    onSelect(null);
  };

  return (
    <div className="demand-tab">
      <div className="demand-fields">
        <input type="search" aria-label="Filter OD entries" placeholder="Filter zones or curves" value={view.query} onChange={(e) => onView({ ...view, query: e.target.value })} />
        <select aria-label="Zone" value={view.zone ?? ''} onChange={(e) => onView({ ...view, zone: e.target.value || null })}>
          <option value="">All zones ({zoneIds.length})</option>
          {model.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.id}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">
        {rows.length} of {model.od.length} entries · {fmtVph(sum)} veh/h at peak. Pick a road on the map to filter by its zone.
      </p>
      <div className="demand-scroll">
        <table className="demand-table od-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={c.num ? 'num' : undefined}
                  aria-sort={view.sort === c.key ? (view.descending ? 'descending' : 'ascending') : undefined}
                >
                  <button type="button" className="sort" onClick={() => onView(toggleSort(view, c.key))}>
                    {c.label}
                    {view.sort === c.key ? (view.descending ? ' ▾' : ' ▴') : ''}
                  </button>
                </th>
              ))}
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((i) => {
              const e = model.od[i]!;
              return (
                <Fragment key={i}>
                  <tr className={invalid.has(`od.${i}`) ? 'invalid' : undefined} aria-selected={selected === i} onClick={() => onSelect(i)}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        aria-expanded={selected === i}
                        aria-label={`Details of entry ${i + 1}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onSelect(selected === i ? null : i);
                        }}
                      >
                        {i + 1}
                      </button>
                    </td>
                    <td>{zoneSelect(i, 'from')}</td>
                    <td>{zoneSelect(i, 'to')}</td>
                    <td className="num">
                      <NumberField label={`Vehicles per hour of entry ${i + 1}`} value={e.vph} disabled={readOnly} onChange={(vph) => edit(i, { vph })} />
                    </td>
                    <td>
                      <CurveSelect label={`Curve of entry ${i + 1}`} value={e.curve} names={curveNames} disabled={readOnly} onChange={(curve) => edit(i, { curve })} />
                    </td>
                    <td>
                      {!readOnly && (
                        <button
                          type="button"
                          className="icon"
                          aria-label={`Remove entry ${i + 1}`}
                          title="Remove"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            remove(i);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                  {selected === i && (
                    <tr className="od-detail">
                      <td colSpan={6}>
                        <CurveChart name={e.curve ?? 'constant'} curve={e.curve ? resolveCurve(e.curve, model.curves) : null} window={window} />
                        <MixEditor
                          title="Vehicle mix of this pair"
                          mix={e.vehicleMix ?? null}
                          names={mixNames.vehicle}
                          fallback="scenario vehicle mix"
                          seed={model.vehicleMix ?? { car: 1 }}
                          disabled={readOnly}
                          onChange={(mix) => edit(i, { vehicleMix: mix ?? undefined })}
                        />
                        <MixEditor
                          title="Driver mix of this pair"
                          mix={e.driverMix ?? null}
                          names={mixNames.driver}
                          fallback="scenario driver mix"
                          seed={model.driverMix ?? { average: 1 }}
                          disabled={readOnly}
                          onChange={(mix) => edit(i, { driverMix: mix ?? undefined })}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="buttons">
        {rows.length > limit && (
          <button type="button" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({rows.length - limit})
          </button>
        )}
        {!readOnly && (
          <button type="button" onClick={add} disabled={zoneIds.length === 0}>
            Add OD entry
          </button>
        )}
      </div>
    </div>
  );
}
