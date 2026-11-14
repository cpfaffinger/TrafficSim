import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScenarioClient } from '../api/scenarioClient';
import { ImportPanel, type ViewerApi } from '../components/ImportPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { NetworkSummaryPanel } from '../components/NetworkSummaryPanel';
import { SimulationPanel, type SimulationSettings } from '../components/SimulationPanel';
import { DataBasisPanel, type ActivityAnalysis } from '../components/DataBasisPanel';
import { ViewToolbar } from '../components/ViewToolbar';
import { DrawRoadPanel } from '../editor/components/DrawRoadPanel';
import { EditorPanel } from '../editor/components/EditorPanel';
import { EditorToolbar } from '../editor/components/EditorToolbar';
import { carrySelection } from '../editor/selection';
import { mergeAttributions } from '../lib/attribution';
import { inspect, PackageIndex } from '../network/inspect';
import type { PickTarget } from '../network/meshData';
import type { BBox, NetworkPackage } from '../network/types';
import { NetworkScene, type BasemapStatus } from '../scene/NetworkScene';
import { useNetworkSimulation } from './useNetworkSimulation';
import { ScenarioPanel } from '../scenarios/ScenarioPanel';
import { SharedScenarioPanel } from '../scenarios/SharedScenarioPanel';
import { useNetworkEditor } from './useNetworkEditor';
import { confirmDiscard } from '../editor/discard';
import type { LonLat, Ring } from '../lib/polygonArea';
import '../editor/editor.css';

export interface NetworkViewerProps {
  api: ViewerApi;
  onAttributions: (attributions: string[]) => void;
  /** Opens a shared scenario read-only (#76): no import and no edit tools. */
  shareToken?: string | null;
  scenarioClient?: ScenarioClient;
}

const language = () => (typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : undefined);

/** Network viewer and editor: import panel, 3D scene, inspector, scenarios and edit tools (glue only; logic lives in lib/, network/, editor/). */
export function NetworkViewer({ api, onAttributions, shareToken = null, scenarioClient }: NetworkViewerProps) {
  const sceneHost = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<NetworkScene | null>(null);
  const [pkg, setPkg] = useState<NetworkPackage | null>(null);
  const [target, setTarget] = useState<PickTarget | null>(null);
  const [basemap, setBasemap] = useState<{ status: BasemapStatus; attribution: string | null }>({ status: 'idle', attribution: null });
  const [geocoderAttribution, setGeocoderAttribution] = useState<string | null>(null);
  const [showTunnels, setShowTunnels] = useState(true);
  const [showBasemap, setShowBasemap] = useState(true);
  const [simSettings, setSimSettings] = useState<SimulationSettings>({ demandScale: 100, truckShare: 0.08, seed: 1 });
  const [analysis, setAnalysis] = useState<ActivityAnalysis | null>(null);
  const readOnly = shareToken !== null;
  const scenarios = useMemo(() => scenarioClient ?? new ScenarioClient(), [scenarioClient]);

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

  // Edited packages replace the displayed one in place: camera and (by OSM ids) selection are kept.
  const shown = useRef<{ index: PackageIndex | null; target: PickTarget | null }>({ index: null, target: null });
  useEffect(() => {
    shown.current = { index, target };
  }, [index, target]);
  const showPackage = useCallback((p: NetworkPackage, keepCamera: boolean) => {
    const before = shown.current;
    const next = keepCamera && before.index ? carrySelection(before.index, new PackageIndex(p), before.target) : null;
    sceneRef.current?.loadPackage(p, { keepCamera });
    sceneRef.current?.select(next);
    setPkg(p);
    setTarget(next);
  }, []);

  const editor = useNetworkEditor({ sceneRef, index, client: scenarios, enabled: !readOnly && index !== null, showPackage });
  const openScenario = editor.session.scenario;
  const sim = useNetworkSimulation(pkg, simSettings, sceneRef, openScenario?.demand ?? undefined);

  // Data basis of the generated scenarios (#115).
  const baselineForAnalysis = pkg?.baselineId ?? null;
  useEffect(() => {
    setAnalysis(null);
    if (!baselineForAnalysis || !api.getNetwork) return;
    const controller = new AbortController();
    api
      .getNetwork(baselineForAnalysis, controller.signal)
      .then((n) => setAnalysis((n.analysis as ActivityAnalysis | undefined) ?? null))
      .catch(() => undefined);
    return () => controller.abort();
  }, [api, baselineForAnalysis]);
  const { startBaseline } = editor.session;

  const onPackage = useCallback(
    (p: NetworkPackage) => {
      if (!confirmDiscard(editor.session.dirty, (m) => window.confirm(m))) return;
      showPackage(p, false);
      if (p.baselineId) startBaseline(p, p.baselineId);
    },
    [showPackage, startBaseline, editor.session.dirty],
  );
  const onSharedPackage = useCallback((p: NetworkPackage) => showPackage(p, false), [showPackage]);

  const onArea = useCallback((area: BBox | Ring | null, closed?: boolean) => sceneRef.current?.showAreaPreview(area, closed ?? true), []);
  const onDraw = useCallback((handler: ((point: LonLat) => void) | null) => {
    sceneRef.current?.setClickHandler(
      handler
        ? (click) => {
            if (click.geo) handler(click.geo);
            return true;
          }
        : null,
    );
  }, []);

  const closeInspector = useCallback(() => {
    setTarget(null);
    sceneRef.current?.select(null);
  }, []);

  const editing = !readOnly && editor.session.baselineId !== null;
  const drawing = editing && editor.mode === 'draw';

  return (
    <div className="viewer">
      <aside className="panel">
        {readOnly ? (
          <SharedScenarioPanel api={scenarios} token={shareToken} onPackage={onSharedPackage} />
        ) : (
          <ImportPanel
            api={api}
            onArea={onArea}
            onDraw={onDraw}
            onPackage={onPackage}
            onGeocoderAttribution={setGeocoderAttribution}
            language={language()}
          />
        )}
        {pkg && <NetworkSummaryPanel pkg={pkg} />}
        {pkg && analysis && <DataBasisPanel analysis={analysis} />}
        {pkg && (
          <SimulationPanel
            running={sim.running}
            ready={sim.ready}
            speed={sim.speed}
            settings={simSettings}
            stats={sim.stats}
            time={sim.time}
            timeOfDay={sim.timeOfDay}
            scenarioName={openScenario?.name ?? null}
            vehicles={sim.vehicles}
            error={sim.error}
            onPlay={sim.play}
            onPause={sim.pause}
            onReset={sim.restart}
            onSpeed={sim.setSpeed}
            onSettings={setSimSettings}
          />
        )}
        {editing && (
          <>
            <EditorToolbar session={editor.session} mode={editor.mode} onMode={editor.setMode} onSave={() => void editor.session.save()} />
            <ScenarioPanel api={scenarios} session={editor.session} />
          </>
        )}
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
        {!pkg && !readOnly && (
          <p className="scene-hint">Search a place to import its road network, or load a recent import.</p>
        )}
        {pkg && (
          <div className="scene-side">
            {drawing && <DrawRoadPanel draft={editor.draft} onFinish={editor.finishRoad} />}
            {editing && !drawing && index && (
              <EditorPanel index={index} target={target} session={editor.session} scope={editor.scope} onScope={editor.setScope} />
            )}
            <InspectorPanel model={model} onClose={closeInspector} />
          </div>
        )}
      </div>
    </div>
  );
}
