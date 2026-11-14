import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeocodeResponse, GeocodeResult, ImportJob, NetworkSummary } from '../api/client';
import { proposeArea, roundBbox } from '../lib/area';
import { runImport, type ImportPhase } from '../lib/importJob';
import { parseNetworkPackage } from '../network/parse';
import type { BBox, NetworkPackage } from '../network/types';
import { AreaEditor } from './AreaEditor';
import { PolygonDrawer } from './PolygonDrawer';
import { roundRing, type LonLat, type Ring } from '../lib/polygonArea';
import { ImportProgress } from './ImportProgress';
import { PlaceSearch } from './PlaceSearch';
import { RecentNetworks } from './RecentNetworks';

/** The backend calls the import workflow needs (implemented by ApiClient; faked in tests). */
export interface ViewerApi {
  geocode(query: string, limit: number, signal?: AbortSignal, lang?: string): Promise<GeocodeResponse>;
  startImport(area: BBox | Ring, signal?: AbortSignal, name?: string): Promise<ImportJob>;
  getImportJob(jobId: string, signal?: AbortSignal): Promise<ImportJob>;
  getPackage(baselineId: string, signal?: AbortSignal): Promise<unknown>;
  listNetworks(limit: number, signal?: AbortSignal): Promise<NetworkSummary[]>;
  renameNetwork?(id: string, name: string, signal?: AbortSignal): Promise<unknown>;
  deleteNetwork?(id: string, signal?: AbortSignal): Promise<void>;
}

export interface ImportPanelProps {
  api: ViewerApi;
  /** Proposed area to preview in the scene (null clears it); rings are drawn as outlines. */
  onArea: (area: BBox | Ring | null, closed?: boolean) => void;
  /** Routes map clicks to the polygon drawer (#110); null releases the map. */
  onDraw?: (handler: ((point: LonLat) => void) | null) => void;
  onPackage: (pkg: NetworkPackage) => void;
  onGeocoderAttribution?: (attribution: string) => void;
  language?: string;
  pollIntervalMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const RECENT_LIMIT = 10;
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Unexpected error');

/** Search → area → import → load (#34), plus "load recent". */
export function ImportPanel({ api, onArea, onDraw, onPackage, onGeocoderAttribution, language, pollIntervalMs, sleep }: ImportPanelProps) {
  const [selection, setSelection] = useState<{ label: string; bbox: BBox } | null>(null);
  const [shape, setShape] = useState<{ ring: LonLat[] } | null>(null);
  const [name, setName] = useState('');
  const drawing = shape !== null;

  // While drawing, every map click adds a corner (#114: no explicit finish step).
  useEffect(() => {
    if (!onDraw || !drawing) return;
    onDraw((point) => setShape((s) => (s ? { ring: [...s.ring, point] } : s)));
    return () => onDraw(null);
  }, [onDraw, drawing]);

  // From three corners on the outline is closed; new corners extend it.
  useEffect(() => {
    if (shape) onArea(shape.ring, shape.ring.length >= 3);
  }, [shape, onArea]);
  const [phase, setPhase] = useState<ImportPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<NetworkSummary[]>([]);
  const abort = useRef<AbortController | null>(null);
  const busy = phase !== null && phase !== 'completed' && phase !== 'failed';

  const refreshRecent = useCallback(
    (signal?: AbortSignal) =>
      api
        .listNetworks(RECENT_LIMIT, signal)
        .then((list) => setRecent(Array.isArray(list) ? list : []))
        .catch(() => undefined),
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshRecent(controller.signal);
    return () => {
      controller.abort();
      abort.current?.abort();
    };
  }, [refreshRecent]);

  const select = (result: GeocodeResult) => {
    const bbox = proposeArea(result);
    setSelection({ label: result.label, bbox });
    setName(result.label.split(',')[0]?.trim() ?? result.label);
    setPhase(null);
    setError(null);
    onArea(bbox);
  };

  const changeArea = (bbox: BBox) => {
    setSelection((s) => (s ? { ...s, bbox } : s));
    onArea(bbox);
  };

  const cancelSelection = () => {
    setSelection(null);
    setShape(null);
    onArea(null);
  };

  const startShape = () => setShape({ ring: [] });
  const backToRectangle = () => {
    setShape(null);
    if (selection) onArea(selection.bbox);
  };

  const load = async (work: (signal: AbortSignal) => Promise<string>) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    try {
      const baselineId = await work(controller.signal);
      setPhase('loading');
      const pkg = parseNetworkPackage(await api.getPackage(baselineId, controller.signal));
      onPackage(pkg);
      setPhase('completed');
      setSelection(null);
      setShape(null);
      onArea(null);
      void refreshRecent();
    } catch (e) {
      if (controller.signal.aborted) {
        setPhase(null);
        return;
      }
      setPhase('failed');
      setError(errorMessage(e));
    }
  };

  const startImport = () => {
    const area: BBox | Ring | null = shape ? (shape.ring.length >= 3 ? roundRing(shape.ring) : null) : selection ? roundBbox(selection.bbox) : null;
    if (!area) return;
    const importName = name.trim() || selection?.label;
    void load((signal) =>
      runImport(api, area, { signal, onPhase: setPhase, pollIntervalMs, ...(sleep ? { sleep } : {}), ...(importName ? { name: importName } : {}) }),
    );
  };

  const renameRecent = (id: string, newName: string) => {
    void api.renameNetwork?.(id, newName).then(() => refreshRecent(), (e: unknown) => setError(errorMessage(e)));
  };

  const deleteRecent = (id: string) => {
    void api.deleteNetwork?.(id).then(() => refreshRecent(), (e: unknown) => setError(errorMessage(e)));
  };

  const loadRecent = (id: string) => {
    setPhase('loading');
    void load(() => Promise.resolve(id));
  };

  return (
    <>
      <PlaceSearch
        search={(q, signal) => api.geocode(q, 6, signal, language)}
        onSelect={select}
        onAttribution={onGeocoderAttribution}
      />
      {(selection ?? shape) && (
        <div className="field import-name">
          <label htmlFor="import-name">Name of the import</label>
          <input id="import-name" value={name} maxLength={120} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vienna inner city" />
        </div>
      )}
      {selection && !shape && (
        <AreaEditor
          label={selection.label}
          bbox={selection.bbox}
          busy={busy}
          onChange={changeArea}
          onImport={startImport}
          onCancel={cancelSelection}
          {...(onDraw ? { onCustomShape: startShape } : {})}
        />
      )}
      {shape && (
        <PolygonDrawer
          ring={shape.ring}
          busy={busy}
          onUndo={() => setShape((s) => (s ? { ring: s.ring.slice(0, -1) } : s))}
          onClear={() => setShape({ ring: [] })}
          onRectangle={backToRectangle}
          onImport={startImport}
          onCancel={cancelSelection}
        />
      )}
      {phase && phase !== 'completed' && (
        <>
          <ImportProgress phase={phase} error={error} />
          {busy && (
            <div className="buttons">
              <button type="button" onClick={() => abort.current?.abort()}>
                Stop waiting
              </button>
            </div>
          )}
        </>
      )}
      <RecentNetworks
        networks={recent}
        disabled={busy}
        onLoad={loadRecent}
        {...(api.renameNetwork ? { onRename: renameRecent } : {})}
        {...(api.deleteNetwork ? { onDelete: deleteRecent } : {})}
        confirm={(m) => window.confirm(m)}
      />
    </>
  );
}
