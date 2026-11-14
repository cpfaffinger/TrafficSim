import { useEffect, useRef } from 'react';

export interface AboutDialogProps {
  open: boolean;
  version: string | null;
  attributions: string[];
  onClose: () => void;
}

const REPO = 'https://github.com/cpfaffinger/TrafficSim';

/** About / legal information (#38): licence of the code, ODbL notice for map data, data sources. */
export function AboutDialog({ open, version, attributions, onClose }: AboutDialogProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="about-title">About TrafficSim</h2>
        <p>
          TrafficSim is a browser-based microscopic traffic simulator for real road networks
          {version ? ` (version ${version})` : ''}.
        </p>
        <h3>Licence</h3>
        <p>
          The source code is free software under the MIT License. Source:{' '}
          <a href={REPO} target="_blank" rel="noreferrer">
            {REPO.replace('https://', '')}
          </a>
          .
        </p>
        <h3>Map data</h3>
        <p>
          Road networks are derived from OpenStreetMap data, © OpenStreetMap contributors, available under the{' '}
          <a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noreferrer">
            Open Database License (ODbL)
          </a>
          . See{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            openstreetmap.org/copyright
          </a>
          . Imported networks are derived databases and remain under the ODbL; images and other works produced from
          them must credit “© OpenStreetMap contributors”. The basemap is rendered from OpenFreeMap vector tiles
          (OpenMapTiles schema, OpenStreetMap data).
        </p>
        <h3>Data sources in use</h3>
        <ul>
          {attributions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <div className="buttons">
          <button type="button" className="primary" ref={closeButton} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
