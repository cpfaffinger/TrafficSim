import type { NetworkSummary } from '../api/client';
import { bboxAreaKm2, formatKm2 } from '../lib/area';
import { ringAreaKm2 } from '../lib/polygonArea';

export interface RecentNetworksProps {
  networks: NetworkSummary[];
  disabled: boolean;
  onLoad: (id: string) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}

/** Recently imported networks (#34), loadable without a new import. */
export function RecentNetworks({ networks, disabled, onLoad }: RecentNetworksProps) {
  if (networks.length === 0) return null;
  return (
    <section aria-label="Recent imports">
      <h2>Recent imports</h2>
      <ul className="result-list">
        {networks.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onLoad(n.id)} disabled={disabled}>
              <span className="result-label">
                {formatKm2(n.polygon ? ringAreaKm2(n.polygon) : bboxAreaKm2(n.bbox))} km²{n.polygon ? ' (custom shape)' : ''} · {n.stats.links} links · {n.stats.signals} signals
              </span>
              <span className="result-category">
                {formatDate(n.createdAt)} UTC · {n.bbox[1].toFixed(3)}, {n.bbox[0].toFixed(3)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
