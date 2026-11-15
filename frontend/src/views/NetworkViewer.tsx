import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScenarioClient, type Scenario } from '../api/scenarioClient';
import { ImportPanel, type ViewerApi } from '../components/ImportPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { NetworkSummaryPanel } from '../components/NetworkSummaryPanel';
import { SimulationPanel, type SimulationSettings } from '../components/SimulationPanel';
import { DataBasisPanel, type ActivityAnalysis } from '../components/DataBasisPanel';
import { DemandEditorHost } from '../demand/DemandEditorHost';
import { ViewToolbar } from '../components/ViewToolbar';
import { StartMap } from '../components/StartMap';
import { DemoIntro } from '../components/DemoIntro';
import { parseNetworkPackage } from '../network/parse';
import { SceneCameraPad } from '../components/SceneCameraPad';
import { SceneCredit } from '../components/SceneCredit';
import { DrawRoadPanel } from '../editor/components/DrawRoadPanel';
import { EditorPanel } from '../editor/components/EditorPanel';
import { EditorToolbar } from '../editor/components/EditorToolbar';
import { carrySelection } from '../editor/selection';
import { mergeAttributions } from '../lib/attribution';
import { inspect, PackageIndex } from '../network/inspect';
import { inspectVehicle } from '../network/vehicleInspect';
import type { PickTarget } from '../network/meshData';
import type { BBox, NetworkPackage } from '../network/types';
import { NetworkScene, type BasemapStatus } from '../scene/NetworkScene';
import { useNetworkSimulation } from './useNetworkSimulation';
import { useHeatmap } from './useHeatmap';
import { HeatmapPanel } from '../components/HeatmapPanel';
import { ScenarioPanel } from '../scenarios/ScenarioPanel';
import { SharedScenarioPanel } from '../scenarios/SharedScenarioPanel';
import { ComparePanel } from '../runs/ComparePanel';
import { RunsPanel, type SimResults } from '../runs/RunsPanel';
import { useNetworkEditor } from './useNetworkEditor';
import { confirmDiscard } from '../editor/discard';
import { isRing, type LonLat, type Ring } from '../lib/polygonArea';
import { debugFileName, debugReport, debugSelection, downloadText } from '../lib/debugReport';
import { BUILD_ID } from '../lib/version';
import '../editor/editor.css';

export interface NetworkViewerProps {
  api: ViewerApi;
  onAttributions: (attributions: string[]) => void;
  /** Opens a shared scenario read-only (#76): no import and no edit tools. */
  shareToken?: string | null;
  scenarioClient?: ScenarioClient;
  /** Opens the sources and licences page (#128). */
  onSources?: () => void;
  /** Shows the synthetic demo town (#145) instead of the import tools. */
  demo?: boolean;
}

const language = () => (typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : undefined);

/** Network viewer and editor: import panel, 3D scene, inspector, scenarios and edit tools (glue only; logic lives in lib/, network/, editor/). */
export function NetworkViewer({ api, onAttributions, shareToken = null, scenarioClient, onSources, demo = false }: NetworkViewerProps) {
  const sceneHost = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<NetworkScene | null>(null);
  const [pkg, setPkg] = useState<NetworkPackage | null>(null);
  const [target, setTarget] = useState<PickTarget | null>(null);
  /** Clicked vehicle (#125): its state, route and trip in the inspector. */
  const [vehicleId, setVehicleId] = useState<number | null>(null);
  const [following, setFollowing] = useState(false);
  const [basemap, setBasemap] = useState<{ status: BasemapStatus; attribution: string | null }>({ status: 'idle', attribution: null });
  const [geocoderAttribution, setGeocoderAttribution] = useState<string | null>(null);
  const [showTunnels, setShowTunnels] = useState(true);
  // The demo town is not a real place: no basemap under it by default.
  const [showBasemap, setShowBasemap] = useState(!demo);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [showTerrain, setShowTerrain] = useState(true);
  const [simSettings, setSimSettings] = useState<SimulationSettings>({ demandScale: 100, truckShare: 0.08, seed: 1 });
  const [analysis, setAnalysis] = useState<ActivityAnalysis | null>(null);
  const [demandOpen, setDemandOpen] = useState(false);
  // An area preview hides the start map (#140); an outline drawn without a search stays on it (#142).
  const [previewing, setPreviewing] = useState(false);
  const previewingRef = useRef(false);
  const [startRing, setStartRing] = useState<Ring | null>(null);
  const [drawHandler, setDrawHandler] = useState<((point: LonLat) => void) | null>(null);
  const hasPackage = useRef(false);
  useEffect(() => {
    hasPackage.current = pkg !== null;
  }, [pkg]);
  const [sharedScenario, setSharedScenario] = useState<Scenario | null>(null);
  const readOnly = shareToken !== null;
  const scenarios = useMemo(() => scenarioClient ?? new ScenarioClient(), [scenarioClient]);

  useEffect(() => {
    if (!sceneHost.current) return;
    const scene = new NetworkScene(sceneHost.current, {
      onPick: (t) => {
        setTarget(t);
        setVehicleId(null);
      },
      onPickVehicle: (id) => {
        setTarget(null);
        setVehicleId(id);
      },
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
  useEffect(() => sceneRef.current?.setTerrainVisible(showTerrain), [showTerrain, pkg]);

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

  // Demo town (#145): loaded once from the backend, shown like an import.
  useEffect(() => {
    if (!demo || !api.getDemoPackage) return;
    const controller = new AbortController();
    api
      .getDemoPackage(controller.signal)
      .then((raw) => showPackage(parseNetworkPackage(raw), false))
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setDemoError(e instanceof Error ? e.message : 'The demo town could not be loaded.');
      });
    return () => controller.abort();
  }, [demo, api, showPackage]);

  const editor = useNetworkEditor({ sceneRef, index, client: scenarios, enabled: !readOnly && !demo && index !== null, showPackage });
  const openScenario = editor.session.scenario;
  const heat = useHeatmap(sceneRef, pkg);
  // Browser run results for saving (#73): the worker answers a `results` request once.
  const pendingResults = useRef<((r: SimResults) => void) | null>(null);
  const onResults = useCallback((r: SimResults) => {
    pendingResults.current?.(r);
    pendingResults.current = null;
  }, []);
  const sim = useNetworkSimulation(pkg, simSettings, sceneRef, openScenario?.demand ?? undefined, heat.onCells, onResults);
  const { requestResults, watchVehicle, requestDebug } = sim;

  // Vehicle inspector (#125): the worker reports the watched vehicle with every stats frame. A new
  // run (restart, other package or settings) has other vehicles: the selection ends.
  const run = `${sim.generation}:${pkg?.baselineId ?? ''}:${simSettings.seed}:${simSettings.demandScale}:${simSettings.truckShare}`;
  const [selectedRun, setSelectedRun] = useState(run);
  if (selectedRun !== run) {
    setSelectedRun(run);
    setVehicleId(null);
  }
  useEffect(() => {
    watchVehicle(vehicleId);
    sceneRef.current?.selectVehicle(vehicleId);
    if (vehicleId === null) sceneRef.current?.showRoute(null);
  }, [vehicleId, watchVehicle]);
  // Following a vehicle (#130) ends with another selection or when it leaves the network.
  const [followedId, setFollowedId] = useState(vehicleId);
  if (followedId !== vehicleId) {
    setFollowedId(vehicleId);
    setFollowing(false);
  }
  const left = sim.vehicle?.left ?? false;
  useEffect(() => {
    sceneRef.current?.followVehicle(following && vehicleId !== null && !left ? vehicleId : null);
  }, [following, vehicleId, left]);
  const vehicleActions = useMemo(
    () =>
      vehicleId === null || left
        ? undefined
        : [
            { label: 'Focus', onClick: () => void sceneRef.current?.focusVehicle(vehicleId) },
            { label: following ? 'Stop following' : 'Follow', onClick: () => setFollowing((f) => !f), pressed: following },
          ],
    [vehicleId, following, left],
  );
  const watched = sim.vehicle;
  const routeKey = watched
    ? `${watched.info.id}:${watched.info.routePos}:${watched.info.route.join()}:${watched.info.trail.length}:${watched.left}`
    : '';
  useEffect(() => {
    if (!watched || vehicleId === null) return;
    const info = watched.info;
    sceneRef.current?.showRoute(watched.left ? null : { ahead: info.route.slice(info.routePos), driven: info.trail.slice(0, -1), original: info.originalRoute });
    // Redraw only when the vehicle moves on to another link (routeKey), not on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, vehicleId]);
  const linkName = useCallback((id: string) => index?.links.get(id)?.name ?? null, [index]);
  // Debug download (#129): the simulation's view of the selection plus its package data.
  const selection = useMemo(() => debugSelection(vehicleId, target, index), [vehicleId, target, index]);
  const simTime = sim.time;
  const downloadDebug = useCallback(async () => {
    if (!selection) return;
    try {
      const json = await requestDebug(selection.kind, selection.id, selection.lane);
      const context = {
        build: BUILD_ID,
        baselineId: pkg?.baselineId ?? null,
        scenario: openScenario ? { id: openScenario.id, name: openScenario.name } : null,
        settings: simSettings,
      };
      downloadText(debugFileName(selection, simTime), JSON.stringify(debugReport(selection, json, context, index), null, 2));
    } catch (error) {
      window.alert(`No debug data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [selection, requestDebug, pkg, simSettings, simTime, index, openScenario]);
  const shownModel = useMemo(
    () => (vehicleId !== null && watched ? inspectVehicle(watched.info, linkName, watched.left) : model),
    [vehicleId, watched, linkName, model],
  );
  const collectResults = useCallback(
    () =>
      new Promise<SimResults>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResults.current = null;
          reject(new Error('The simulation did not answer; play it first.'));
        }, 10000);
        pendingResults.current = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
        requestResults();
      }),
    [requestResults],
  );
  const [runsVersion, setRunsVersion] = useState(0);
  const onRunsChanged = useCallback(() => setRunsVersion((v) => v + 1), []);

  // Demand editor (#54): the open scenario, or the shared one read-only.
  const demandScenario = readOnly ? sharedScenario : openScenario;
  const openScenarioId = openScenario?.id;
  const { setScenario } = editor.session;
  const saveDemand = useCallback(
    async (demand: Record<string, unknown>) => {
      if (openScenarioId) setScenario(await scenarios.updateScenario(openScenarioId, { demand }));
    },
    [openScenarioId, scenarios, setScenario],
  );
  const showSharedDemand = useCallback((s: Scenario) => {
    setSharedScenario(s);
    setDemandOpen(true);
  }, []);

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

  const onArea = useCallback((area: BBox | Ring | null, closed?: boolean) => {
    // Nothing shown in the scene yet: the outline is drawn on the start map (#142).
    // (An empty outline is a ring just started: a box always has four numbers.)
    if (area && (area.length === 0 || isRing(area)) && !hasPackage.current && !previewingRef.current) {
      setStartRing(area as Ring);
      return;
    }
    setStartRing(null);
    previewingRef.current = !!area && area.length > 0;
    setPreviewing(previewingRef.current);
    sceneRef.current?.showAreaPreview(area, closed ?? true);
  }, []);
  const onDraw = useCallback((handler: ((point: LonLat) => void) | null) => {
    setDrawHandler(() => handler);
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
    setVehicleId(null);
    sceneRef.current?.select(null);
  }, []);

  const editing = !readOnly && editor.session.baselineId !== null;
  const drawing = editing && editor.mode === 'draw';

  return (
    <div className="viewer">
      <aside className="panel">
        {readOnly ? (
          <SharedScenarioPanel api={scenarios} token={shareToken} onPackage={onSharedPackage} onShowDemand={showSharedDemand} />
        ) : demo ? (
          <DemoIntro error={demoError} />
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
        <ViewToolbar
          showBasemap={showBasemap}
          showTunnels={showTunnels}
          basemapStatus={basemap.status}
          canReset={pkg !== null}
          onShowBasemap={setShowBasemap}
          onShowTunnels={setShowTunnels}
          showTerrain={showTerrain}
          onShowTerrain={pkg?.terrain ? setShowTerrain : undefined}
          onReset={() => sceneRef.current?.resetView()}
        />
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
        {pkg && (
          <HeatmapPanel
            enabled={heat.enabled}
            metric={heat.metric}
            smooth={heat.smooth}
            range={heat.range}
            bucket={heat.bucket}
            live={heat.live}
            replaying={heat.replaying}
            timeOfDay={heat.timeOfDay}
            onEnabled={heat.setEnabled}
            onMetric={heat.setMetric}
            onSmooth={heat.setSmooth}
            onBucket={heat.setBucket}
            onLive={heat.goLive}
            onReplay={heat.replay}
            comparing={heat.diff?.label ?? null}
            onExitCompare={() => heat.setDiff(null)}
          />
        )}
        {editing && (
          <>
            <EditorToolbar session={editor.session} mode={editor.mode} onMode={editor.setMode} onSave={() => void editor.session.save()} />
            <ScenarioPanel api={scenarios} session={editor.session} onEditDemand={() => setDemandOpen(true)} />
            {openScenario && (
              <RunsPanel
                api={scenarios}
                scenario={openScenario}
                seed={simSettings.seed}
                collectResults={sim.ready ? collectResults : null}
                onRunsChanged={onRunsChanged}
              />
            )}
            {pkg && editor.session.baselineId && (
              <ComparePanel api={scenarios} baselineId={editor.session.baselineId} pkg={pkg} onDiff={heat.setDiff} refreshKey={runsVersion} />
            )}
          </>
        )}
      </aside>
      <div className="scene-wrap">
        <div className="scene" ref={sceneHost} />
        {!pkg && !previewing && !readOnly && !demo && <StartMap ring={startRing} onPick={startRing ? drawHandler : null} />}
        {(pkg || previewing) && <SceneCameraPad scene={() => sceneRef.current} />}
        {onSources && <SceneCredit onSources={onSources} />}
        {pkg && demandOpen && demandScenario && (
          <DemandEditorHost
            scenario={demandScenario}
            pkg={pkg}
            sceneRef={sceneRef}
            target={target}
            readOnly={readOnly}
            onSave={readOnly ? undefined : saveDemand}
            onClose={() => setDemandOpen(false)}
          />
        )}
        {pkg && (
          <div className="scene-side">
            {drawing && <DrawRoadPanel draft={editor.draft} onFinish={editor.finishRoad} />}
            {editing && !drawing && index && (
              <EditorPanel index={index} target={target} session={editor.session} scope={editor.scope} onScope={editor.setScope} />
            )}
            <InspectorPanel
              model={shownModel}
              onClose={closeInspector}
              onDebug={sim.ready && selection ? () => void downloadDebug() : undefined}
              actions={vehicleActions}
            />
          </div>
        )}
      </div>
    </div>
  );
}
