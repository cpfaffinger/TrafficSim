import { useState } from 'react';
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
 * View options and camera help over the 3D scene (#33, #36, #96). On phones the options fold
 * into one button so the scene keeps the space (#121); desktops always show them.
 */
export function ViewToolbar(p: ViewToolbarProps) {
  const note = BASEMAP_NOTE[p.basemapStatus];
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? 'view-toolbar open' : 'view-toolbar'} role="toolbar" aria-label="View options">
      <button
        type="button"
        className="view-toolbar-toggle"
        aria-expanded={open}
        aria-label={open ? 'Hide view options' : 'Show view options'}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '✕' : '☰'}
      </button>
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
