import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient, type BackendStatus } from './api/client';
import { AboutDialog } from './components/AboutDialog';
import { ModeTabs, type AppMode } from './components/ModeTabs';
import { mergeAttributions } from './lib/attribution';
import { NetworkViewer } from './views/NetworkViewer';
import { RingDemo } from './views/RingDemo';
import { shareTokenFrom } from './scenarios/shareUrl';

import { UpdateBanner } from './components/UpdateBanner';
import { BUILD_ID, isOutdated, VERSION_CHECK_MS } from './lib/version';

export function App() {
  const api = useMemo(() => new ApiClient(), []);
  const [mode, setMode] = useState<AppMode>('network');
  const [status, setStatus] = useState<BackendStatus | 'unknown'>('unknown');
  const [version, setVersion] = useState<string | null>(null);
  const [metaAttributions, setMetaAttributions] = useState<string[]>([]);
  const [viewerAttributions, setViewerAttributions] = useState<string[]>([]);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [outdated, setOutdated] = useState(false);

  // Detect a newer deployment while this tab is open (hashed assets + no-cache index.html).
  useEffect(() => {
    const controller = new AbortController();
    const check = () =>
      api
        .getMeta(controller.signal)
        .then((meta) => setOutdated(isOutdated(BUILD_ID, meta.version)))
        .catch(() => undefined);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const interval = setInterval(check, VERSION_CHECK_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [api]);
  const shareToken = useMemo(() => shareTokenFrom(window.location.search), []);

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
        setOutdated(isOutdated(BUILD_ID, meta.version));
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
        <button type="button" className="link-button header-about" aria-label="About and sources" onClick={() => setAboutOpen(true)}>
          About
        </button>
        <span className={`status-dot ${status}`} role="img" aria-label={`Backend ${status}`} title={`Backend ${status}`} />
      </header>
      {outdated && <UpdateBanner onReload={() => window.location.reload()} />}
      <main className="app-main" id={`panel-${mode}`} role="tabpanel" aria-labelledby={`tab-${mode}`}>
        {mode === 'network' ? (
          <NetworkViewer api={api} onAttributions={setViewerAttributions} shareToken={shareToken} onSources={() => setAboutOpen(true)} />
        ) : (
          <RingDemo status={status} version={version} />
        )}
      </main>
      <AboutDialog open={aboutOpen} version={version} attributions={attributions} onClose={closeAbout} />
    </div>
  );
}
