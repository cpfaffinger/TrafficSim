import { formatKm2 } from '../lib/area';
import { ringAreaKm2, ringProblem, type Ring } from '../lib/polygonArea';

export interface PolygonDrawerProps {
  ring: Ring;
  closed: boolean;
  busy: boolean;
  onUndo: () => void;
  onClear: () => void;
  onFinish: () => void;
  onRectangle: () => void;
  onImport: () => void;
  onCancel: () => void;
}

/** Drawing a custom import outline (#110): click corners on the map, then finish and import. */
export function PolygonDrawer({ ring, closed, busy, onUndo, onClear, onFinish, onRectangle, onImport, onCancel }: PolygonDrawerProps) {
  const problem = ringProblem(ring);
  return (
    <section aria-label="Custom import area">
      <h2>Import area — custom shape</h2>
      <p className="muted">
        {closed ? 'Shape finished. Import it or keep editing.' : 'Click on the map to add corners. Finish when the outline is complete.'}
      </p>
      <p className="area-size">
        Corners: <strong>{ring.length}</strong> · Area: <strong>{formatKm2(ringAreaKm2(ring))} km²</strong>
      </p>
      {ring.length >= 3 && problem && <p className="error">{problem}</p>}
      <div className="buttons">
        {!closed && (
          <button type="button" onClick={onFinish} disabled={busy || problem !== null}>
            Finish shape
          </button>
        )}
        <button type="button" onClick={onUndo} disabled={busy || ring.length === 0}>
          Undo corner
        </button>
        <button type="button" onClick={onClear} disabled={busy || ring.length === 0}>
          Clear
        </button>
      </div>
      <div className="buttons">
        <button type="button" className="primary" onClick={onImport} disabled={busy || !closed || problem !== null}>
          Import this area
        </button>
        <button type="button" onClick={onRectangle} disabled={busy}>
          Use a rectangle
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}
