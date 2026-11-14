import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient, type BackendStatus } from './api/client';
import { AboutDialog } from './components/AboutDialog';
import { AttributionBar } from './components/AttributionBar';
import { ModeTabs, type AppMode } from './components/ModeTabs';
import { mergeAttributions } from './lib/attribution';
import { NetworkViewer } from './views/NetworkViewer';
import { RingDemo } from './views/RingDemo';

export function App() {
  const api = useMemo(() => new ApiClient(), []);
  const [mode, setMode] = useState<AppMode>('network');
  const [status, setStatus] = useState<BackendStatus | 'unknown'>('unknown');
  const [version, setVersion] = useState<string | null>(null);
  const [metaAttributions, setMetaAttributions] = useState<string[]>([]);
  const [viewerAttributions, setViewerAttributions] = useState<string[]>([]);
  const [aboutOpen, setAboutOpen] = useState(false);

  // Backend status and metadata.
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      api
        .getStatus(controller.signal)
        .then(setStatus)
        .catch(() => undefined);
    void refresh();
    api
      .getMeta(controller.signal)
      .then((meta) => {
        setVersion(meta.version);
        setMetaAttributions(meta.attributions);
      })
      .catch(() => undefined);
    const interval = setInterval(refresh, 15_000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [api]);

  const attributions = useMemo(
    () => mergeAttributions(mode === 'network' ? viewerAttributions : [], metaAttributions),
    [mode, viewerAttributions, metaAttributions],
  );
  const closeAbout = useCallback(() => setAboutOpen(false), []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>TrafficSim</h1>
        <ModeTabs mode={mode} onChange={setMode} />
        <span className={`status-dot ${status}`} role="img" aria-label={`Backend ${status}`} title={`Backend ${status}`} />
      </header>
      <main className="app-main" id={`panel-${mode}`} role="tabpanel" aria-labelledby={`tab-${mode}`}>
        {mode === 'network' ? (
          <NetworkViewer api={api} onAttributions={setViewerAttributions} />
        ) : (
          <RingDemo status={status} version={version} />
        )}
      </main>
      <AttributionBar attributions={attributions} onAbout={() => setAboutOpen(true)} />
      <AboutDialog open={aboutOpen} version={version} attributions={attributions} onClose={closeAbout} />
    </div>
  );
}
