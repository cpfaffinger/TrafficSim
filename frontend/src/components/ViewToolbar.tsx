import type { BasemapStatus } from '../scene/NetworkScene';

export interface ViewToolbarProps {
  showBasemap: boolean;
  showTunnels: boolean;
  /** Terrain toggle (#87); omitted when the network has no terrain. */
  showTerrain?: boolean;
  onShowTerrain?: (v: boolean) => void;
  basemapStatus: BasemapStatus;
  canReset: boolean;
  onShowBasemap: (v: boolean) => void;
  onShowTunnels: (v: boolean) => void;
  onReset: () => void;
}

const BASEMAP_NOTE: Partial<Record<BasemapStatus, string>> = {
  loading: 'loading basemap…',
  unavailable: 'basemap unavailable — plain ground',
};

/**
 * View options and camera help (#33, #36, #96) in the side panel, so the 3D scene itself stays free of
 * controls (#128).
 */
export function ViewToolbar(p: ViewToolbarProps) {
  const note = BASEMAP_NOTE[p.basemapStatus];
  return (
    <section className="view-options" role="toolbar" aria-label="View options">
      <h2>View</h2>
      <div className="view-options-row">
        <label>
          <input type="checkbox" checked={p.showBasemap} onChange={(e) => p.onShowBasemap(e.target.checked)} /> Basemap
        </label>
        <label>
          <input type="checkbox" checked={p.showTunnels} onChange={(e) => p.onShowTunnels(e.target.checked)} /> Tunnels
        </label>
        {p.onShowTerrain && (
          <label>
            <input type="checkbox" checked={p.showTerrain ?? true} onChange={(e) => p.onShowTerrain?.(e.target.checked)} /> Terrain
          </label>
        )}
        <button type="button" onClick={p.onReset} disabled={!p.canReset}>
          Reset view
        </button>
      </div>
      {note && (
        <p className="muted small" role="status">
          {note}
        </p>
      )}
      <p className="muted small">Click a vehicle, lane, junction or bridge to inspect it; click the same spot again to select what lies below.</p>
      <details className="camera-help">
        <summary>Camera controls</summary>
        <ul>
          <li>Drag: pan · Right-drag or Shift+drag: rotate and tilt</li>
          <li>Wheel or pinch: zoom to cursor</li>
          <li>Keys (click the view first): WASD/arrows pan, Q/E rotate, R/F tilt, +/− zoom</li>
        </ul>
      </details>
    </section>
  );
}
