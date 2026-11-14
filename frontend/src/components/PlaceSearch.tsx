import { useRef, useState, type FormEvent } from 'react';
import type { GeocodeResponse, GeocodeResult } from '../api/client';

export interface PlaceSearchProps {
  search: (query: string, signal: AbortSignal) => Promise<GeocodeResponse>;
  onSelect: (result: GeocodeResult) => void;
  /** Reports the geocoder's attribution once results were shown. */
  onAttribution?: (attribution: string) => void;
}

/**
 * Place search (#34). Searches on submit only — no search-as-you-type — to respect the free
 * geocoders' usage policies.
 */
export function PlaceSearch({ search, onSelect, onAttribution }: PlaceSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [attribution, setAttribution] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await search(q, controller.signal);
      setResults(response.results);
      setAttribution(response.attribution || null);
      if (response.attribution) onAttribution?.(response.attribution);
    } catch (err) {
      if (controller.signal.aborted) return;
      setResults(null);
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };

  return (
    <section aria-label="Place search">
      <h2>Find a place</h2>
      <form role="search" className="search-form" onSubmit={submit}>
        <label htmlFor="place-query" className="visually-hidden">
          Place, address or street
        </label>
        <input
          id="place-query"
          type="search"
          placeholder="e.g. Karlsplatz, Vienna"
          value={query}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      <div aria-live="polite">
        {error && <p className="error">Search failed: {error}</p>}
        {results && results.length === 0 && <p className="muted">No places found.</p>}
      </div>
      {results && results.length > 0 && (
        <ul className="result-list" aria-label="Search results">
          {results.map((r) => (
            <li key={`${r.osmReference ?? ''}${r.label}${r.latitude}${r.longitude}`}>
              <button type="button" onClick={() => onSelect(r)}>
                <span className="result-label">{r.label}</span>
                <span className="result-category">{r.category.replace(/_/g, ' ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {attribution && results && <p className="source-note">Search: {attribution}</p>}
    </section>
  );
}
