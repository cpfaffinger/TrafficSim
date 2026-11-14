import { useState } from 'react';
import { bboxAreaKm2, bboxSizeKm, formatKm2, resizeBbox } from '../lib/area';
import type { BBox } from '../network/types';

export interface AreaEditorProps {
  label: string;
  bbox: BBox;
  busy: boolean;
  onChange: (bbox: BBox) => void;
  onImport: () => void;
  onCancel: () => void;
  /** Switch to drawing a custom outline (#110). */
  onCustomShape?: () => void;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Shows and resizes the proposed import area (#34). */
export function AreaEditor({ label, bbox, busy, onChange, onImport, onCancel, onCustomShape }: AreaEditorProps) {
  const size = bboxSizeKm(bbox);
  // Keep the typed text while editing; commit on valid numbers only.
  const [draft, setDraft] = useState<{ w: string; h: string } | null>(null);
  const width = draft?.w ?? String(round2(size.widthKm));
  const height = draft?.h ?? String(round2(size.heightKm));

  const commit = (w: string, h: string) => {
    setDraft({ w, h });
    const wk = Number(w);
    const hk = Number(h);
    if (Number.isFinite(wk) && Number.isFinite(hk) && wk > 0 && hk > 0) onChange(resizeBbox(bbox, wk, hk));
  };

  return (
    <section aria-label="Import area">
      <h2>Import area</h2>
      <p className="area-label">{label}</p>
      <div className="area-fields">
        <div className="field">
          <label htmlFor="area-width">Width (km)</label>
          <input
            id="area-width"
            type="number"
            min={0.1}
            max={20}
            step={0.1}
            value={width}
            onChange={(e) => commit(e.target.value, height)}
            onBlur={() => setDraft(null)}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label htmlFor="area-height">Height (km)</label>
          <input
            id="area-height"
            type="number"
            min={0.1}
            max={20}
            step={0.1}
            value={height}
            onChange={(e) => commit(width, e.target.value)}
            onBlur={() => setDraft(null)}
            disabled={busy}
          />
        </div>
      </div>
      <p className="area-size">
        Area: <strong>{formatKm2(bboxAreaKm2(bbox))} km²</strong>
      </p>
      <div className="buttons">
        <button type="button" className="primary" onClick={onImport} disabled={busy}>
          Import this area
        </button>
        {onCustomShape && (
          <button type="button" onClick={onCustomShape} disabled={busy}>
            Draw custom shape
          </button>
        )}
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}
