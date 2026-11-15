import { formatKm2 } from '../lib/area';
import { ringAreaKm2, ringProblem, type Ring } from '../lib/polygonArea';

export interface PolygonDrawerProps {
  ring: Ring;
  busy: boolean;
  onUndo: () => void;
  onClear: () => void;
  /** Back to the searched rectangle; absent when the outline was started on the map (#142). */
  onRectangle?: () => void;
  onImport: () => void;
  onCancel: () => void;
}

/**
 * Drawing a custom import outline directly on the basemap (#110, #114): every click adds a corner;
 * from three corners on the outline is closed automatically and new corners extend it.
 */
export function PolygonDrawer({ ring, busy, onUndo, onClear, onRectangle, onImport, onCancel }: PolygonDrawerProps) {
  const problem = ringProblem(ring);
  const closed = ring.length >= 3;
  return (
    <section aria-label="Custom import area">
      <h2>Import area — custom shape</h2>
      <p className="muted">
        {closed
          ? 'Click on the map to add more corners; the outline closes automatically.'
          : `Click on the map to add corners (${3 - ring.length} more to close the outline).`}
      </p>
      <p className="area-size">
        Corners: <strong>{ring.length}</strong> · Area: <strong>{formatKm2(ringAreaKm2(ring))} km²</strong>
      </p>
      {closed && problem && <p className="error">{problem}</p>}
      <div className="buttons">
        <button type="button" onClick={onUndo} disabled={busy || ring.length === 0}>
          Undo corner
        </button>
        <button type="button" onClick={onClear} disabled={busy || ring.length === 0}>
          Clear
        </button>
      </div>
      <div className="buttons">
        <button type="button" className="primary" onClick={onImport} disabled={busy || problem !== null}>
          Import this area
        </button>
        {onRectangle && (
          <button type="button" onClick={onRectangle} disabled={busy}>
            Use a rectangle
          </button>
        )}
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}
