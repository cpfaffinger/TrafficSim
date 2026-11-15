import { useCallback, useEffect, useRef, useState } from 'react';
import { lonLatToTile } from '../basemap/tiles';

/** Start view before anything is searched (#140): the OSM map of Europe with Austria in the middle. */
export const START_VIEW = { lat: 47.6, lon: 13.35, zoom: 7 };

const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;
const TILE_URL = 'https://tile.openstreetmap.org';

interface View {
  zoom: number;
  /** Centre in world pixels at `zoom`. */
  x: number;
  y: number;
}

function initialView(): View {
  const [tx, ty] = lonLatToTile(START_VIEW.lon, START_VIEW.lat, START_VIEW.zoom);
  return { zoom: START_VIEW.zoom, x: tx * TILE, y: ty * TILE };
}

/** The view zoomed by `delta` levels, keeping the world point under `(px, py)` (offset from the centre) in place. */
function zoomAt(v: View, delta: number, px: number, py: number): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom + delta));
  const f = 2 ** (zoom - v.zoom);
  return { zoom, x: (v.x + px) * f - px, y: (v.y + py) * f - py };
}

/** Pannable, zoomable OpenStreetMap raster map shown under the panels while no network or area is shown. */
export function StartMap() {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(initialView);
  const [size, setSize] = useState({ w: 1024, h: 768 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const wheel = useRef(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setSize({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Wheel zoom by whole levels around the cursor (non-passive, so the page does not scroll).
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheel.current += e.deltaY;
      if (Math.abs(wheel.current) < 60) return;
      const delta = wheel.current < 0 ? 1 : -1;
      wheel.current = 0;
      const r = el.getBoundingClientRect();
      setView((v) => zoomAt(v, delta, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
  }, []);
  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    setView((v) => zoomAt(v, 1, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2));
  }, []);

  const n = 2 ** view.zoom;
  const left = view.x - size.w / 2;
  const top = view.y - size.h / 2;
  const tiles: { key: string; src: string; x: number; y: number }[] = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + size.h) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + size.w) / TILE); tx++) {
      const wx = ((tx % n) + n) % n;
      tiles.push({ key: `${view.zoom}/${tx}/${ty}`, src: `${TILE_URL}/${view.zoom}/${wx}/${ty}.png`, x: tx * TILE - left, y: ty * TILE - top });
    }
  }

  return (
    <div
      ref={host}
      className="start-map"
      role="application"
      aria-label="Map of Europe. Drag to pan, wheel or double-click to zoom. Search a place to import its road network."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {tiles.map((t) => (
        // CORS mode: the app is cross-origin isolated (COEP require-corp); OSM tiles allow any origin.
        <img key={t.key} src={t.src} alt="" crossOrigin="anonymous" draggable={false} style={{ left: t.x, top: t.y }} />
      ))}
      <div className="start-map-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => setView((v) => zoomAt(v, 1, 0, 0))}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => setView((v) => zoomAt(v, -1, 0, 0))}>
          −
        </button>
      </div>
      <div className="start-map-credit">
        ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap
        </a>{' '}
        contributors
      </div>
    </div>
  );
}
