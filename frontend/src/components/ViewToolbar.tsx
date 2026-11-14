import type { BasemapStatus } from '../scene/NetworkScene';

export interface ViewToolbarProps {
  showBasemap: boolean;
  showTunnels: boolean;
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

/** View options and camera help over the 3D scene (#33, #36, #96). */
export function ViewToolbar(p: ViewToolbarProps) {
  const note = BASEMAP_NOTE[p.basemapStatus];
  return (
    <div className="view-toolbar" role="toolbar" aria-label="View options">
      <label>
        <input type="checkbox" checked={p.showBasemap} onChange={(e) => p.onShowBasemap(e.target.checked)} /> Basemap
      </label>
      <label>
        <input type="checkbox" checked={p.showTunnels} onChange={(e) => p.onShowTunnels(e.target.checked)} /> Tunnels
      </label>
      <button type="button" onClick={p.onReset} disabled={!p.canReset}>
        Reset view
      </button>
      {note && (
        <span className="muted small" role="status">
          {note}
        </span>
      )}
      <details className="camera-help">
        <summary>Controls</summary>
        <ul>
          <li>Drag: pan · Right-drag or Shift+drag: rotate and tilt</li>
          <li>Wheel or pinch: zoom to cursor</li>
          <li>Keys (click the view first): WASD/arrows pan, Q/E rotate, R/F tilt, +/− zoom</li>
          <li>Click: inspect · click again: select the level below</li>
        </ul>
      </details>
    </div>
  );
}
