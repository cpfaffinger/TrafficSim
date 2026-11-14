import { useId } from 'react';
import { normalizeMix, setSharePercent } from '../edits';
import type { Mix } from '../model';

export interface MixEditorProps {
  title: string;
  mix: Mix | null;
  /** Known names (built-ins plus the scenario's own); unknown names in the mix are listed too. */
  names: readonly string[];
  onChange: (mix: Mix | null) => void;
  /** What applies without an own mix, e.g. "cars only". */
  fallback: string;
  /** Mix used when switching to an own mix. */
  seed: Mix;
  disabled?: boolean;
}

const pct = (share: number | undefined) => Math.round((share ?? 0) * 1000) / 10;

/** Linked percentage sliders for vehicle-type or driver-profile shares (the sim core normalises weights). */
export function MixEditor({ title, mix, names, onChange, fallback, seed, disabled }: MixEditorProps) {
  const id = useId();
  const shares = normalizeMix(mix);
  const all = [...names, ...Object.keys(mix ?? {}).filter((n) => !names.includes(n))];
  return (
    <fieldset className="mix-editor">
      <legend>{title}</legend>
      <label className="check">
        <input type="checkbox" checked={mix !== null} disabled={disabled} onChange={(e) => onChange(e.target.checked ? { ...seed } : null)} />
        Own mix {mix === null && <span className="muted">(now: {fallback})</span>}
      </label>
      {mix !== null &&
        all.map((name) => (
          <div className="mix-row" key={name}>
            <label htmlFor={`${id}-${name}`} className={names.includes(name) ? undefined : 'error'}>
              {name}
            </label>
            <input
              id={`${id}-${name}`}
              type="range"
              min={0}
              max={100}
              step={1}
              value={pct(shares[name])}
              disabled={disabled}
              onChange={(e) => onChange(setSharePercent(mix, names, name, Number(e.target.value)))}
            />
            <input
              type="number"
              className="num"
              aria-label={`${name} share (%)`}
              min={0}
              max={100}
              step={0.1}
              value={pct(shares[name])}
              disabled={disabled}
              onChange={(e) => onChange(setSharePercent(mix, names, name, Number(e.target.value)))}
            />
            <span className="muted">%</span>
          </div>
        ))}
    </fieldset>
  );
}
