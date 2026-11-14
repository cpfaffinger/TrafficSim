import { NumberField } from '../demand/components/fields';
import type { TransitLine } from '../network/types';
import { effectiveHeadway, lineLabel, lineVariants, patchTransit, readTransit } from './model';

export interface TransitTabProps {
  lines: readonly TransitLine[];
  /** The scenario config's `transit` value (opaque; unknown keys are kept). */
  value: unknown;
  readOnly: boolean;
  onChange: (value: Record<string, unknown>) => void;
}

const minutes = (seconds: number | null): string => (seconds === null ? '–' : `${Math.round((seconds / 60) * 10) / 10} min`);

/**
 * Bus lines of the network (#85): service on/off, dwell times, headway factor and a headway per
 * line, written to the scenario's `transit` simulation config.
 */
export function TransitTab({ lines, value, readOnly, onChange }: TransitTabProps) {
  const settings = readTransit(value);
  const variants = lineVariants(lines);
  const set = (patch: Parameters<typeof patchTransit>[1]) => onChange(patchTransit(value, patch));
  return (
    <div className="demand-tab">
      <div className="demand-fields">
        <label>
          <input type="checkbox" checked={settings.enabled} disabled={readOnly} onChange={(e) => set({ enabled: e.target.checked })} /> Run buses
        </label>
        <label>
          Dwell time (s)
          <NumberField label="Dwell time" value={settings.dwellTime} disabled={readOnly} onChange={(v) => set({ dwellTime: v })} />
        </label>
        <label>
          + random up to (s)
          <NumberField label="Random dwell time" value={settings.dwellTimeRandom} disabled={readOnly} onChange={(v) => set({ dwellTimeRandom: v })} />
        </label>
        <label>
          Headway factor
          <NumberField label="Headway factor" value={settings.headwayFactor} step={0.1} disabled={readOnly} onChange={(v) => set({ headwayFactor: v })} />
        </label>
        <label>
          Default headway (min)
          <NumberField
            label="Default headway"
            value={settings.defaultHeadway / 60}
            min={0.5}
            disabled={readOnly}
            onChange={(v) => set({ defaultHeadway: v * 60 })}
          />
        </label>
      </div>
      <p className="muted small">
        Lines and stops come from OpenStreetMap route relations. A line without an OSM interval runs at the default headway; a headway of 0 takes
        it out of service. The factor scales every headway.
      </p>
      <table className="demand-table" aria-label="Bus lines">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col" className="num">
              Stops
            </th>
            <th scope="col" className="num">
              OSM headway
            </th>
            <th scope="col" className="num">
              Headway (min)
            </th>
            <th scope="col" className="num">
              Effective
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const override = settings.headways[line.id];
            return (
              <tr key={line.id}>
                <th scope="row" title={line.name ?? undefined}>
                  <span className="line-swatch" style={{ background: line.colour ?? '#8c45c7' }} aria-hidden="true" /> {lineLabel(line)}
                  {line.name && line.ref && <span className="muted small"> {line.name}</span>}
                </th>
                <td className="num">{line.stops.length}</td>
                <td className="num">{minutes(line.headway)}</td>
                <td className="num">
                  <input
                    type="number"
                    className="num"
                    aria-label={`Headway of line ${lineLabel(line)} (${line.id})`}
                    min={0}
                    step="any"
                    placeholder={line.headway === null ? 'default' : 'OSM'}
                    value={override === undefined ? '' : String(override / 60)}
                    disabled={readOnly}
                    onChange={(e) => set({ headways: { [line.id]: e.target.value.trim() === '' ? null : Number(e.target.value) * 60 } })}
                  />
                </td>
                <td className="num">{effectiveHeadway(line, settings, variants.get(line.id)) === null ? 'off' : minutes(effectiveHeadway(line, settings, variants.get(line.id)))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
