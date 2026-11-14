import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImportPanel, type ViewerApi } from '../components/ImportPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { NetworkSummaryPanel } from '../components/NetworkSummaryPanel';
import { ViewToolbar } from '../components/ViewToolbar';
import { mergeAttributions } from '../lib/attribution';
import { inspect, PackageIndex } from '../network/inspect';
import type { PickTarget } from '../network/meshData';
import type { BBox, NetworkPackage } from '../network/types';
import { NetworkScene, type BasemapStatus } from '../scene/NetworkScene';

export interface NetworkViewerProps {
  api: ViewerApi;
  onAttributions: (attributions: string[]) => void;
}

const language = () => (typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : undefined);

/** Phase 3 network viewer: import panel, 3D scene, inspector (glue only; logic lives in lib/ and network/). */
export function NetworkViewer({ api, onAttributions }: NetworkViewerProps) {
  const sceneHost = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<NetworkScene | null>(null);
  const [pkg, setPkg] = useState<NetworkPackage | null>(null);
  const [target, setTarget] = useState<PickTarget | null>(null);
  const [basemap, setBasemap] = useState<{ status: BasemapStatus; attribution: string | null }>({ status: 'idle', attribution: null });
  const [geocoderAttribution, setGeocoderAttribution] = useState<string | null>(null);
  const [showTunnels, setShowTunnels] = useState(true);
  const [showBasemap, setShowBasemap] = useState(true);

  useEffect(() => {
    if (!sceneHost.current) return;
    const scene = new NetworkScene(sceneHost.current, {
      onPick: setTarget,
      onBasemap: (status, attribution) => setBasemap((b) => ({ status, attribution: attribution ?? (status === 'ready' ? b.attribution : null) })),
    });
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => sceneRef.current?.setTunnelsVisible(showTunnels), [showTunnels]);
  useEffect(() => sceneRef.current?.setBasemapVisible(showBasemap), [showBasemap]);

  const index = useMemo(() => (pkg ? new PackageIndex(pkg) : null), [pkg]);
  const model = useMemo(() => (index && target ? inspect(index, target) : null), [index, target]);

  useEffect(() => {
    onAttributions(
      mergeAttributions(pkg?.attribution, basemap.attribution ? [basemap.attribution] : [], geocoderAttribution ? [geocoderAttribution] : []),
    );
  }, [pkg, basemap.attribution, geocoderAttribution, onAttributions]);

  const onPackage = useCallback((p: NetworkPackage) => {
    sceneRef.current?.loadPackage(p);
    setPkg(p);
    setTarget(null);
  }, []);

  const onArea = useCallback((bbox: BBox | null) => sceneRef.current?.showAreaPreview(bbox), []);

  const closeInspector = useCallback(() => {
    setTarget(null);
    sceneRef.current?.select(null);
  }, []);

  return (
    <div className="viewer">
      <aside className="panel">
        <ImportPanel
          api={api}
          onArea={onArea}
          onPackage={onPackage}
          onGeocoderAttribution={setGeocoderAttribution}
          language={language()}
        />
        {pkg && <NetworkSummaryPanel pkg={pkg} />}
      </aside>
      <div className="scene-wrap">
        <div className="scene" ref={sceneHost} />
        <ViewToolbar
          showBasemap={showBasemap}
          showTunnels={showTunnels}
          basemapStatus={basemap.status}
          canReset={pkg !== null}
          onShowBasemap={setShowBasemap}
          onShowTunnels={setShowTunnels}
          onReset={() => sceneRef.current?.resetView()}
        />
        {!pkg && (
          <p className="scene-hint">Search a place to import its road network, or load a recent import.</p>
        )}
        {pkg && <InspectorPanel model={model} onClose={closeInspector} />}
      </div>
    </div>
  );
}
