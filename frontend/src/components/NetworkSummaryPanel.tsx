import { bboxAreaKm2, formatKm2 } from '../lib/area';
import type { NetworkPackage } from '../network/types';

/** Key figures of the loaded network package. */
export function NetworkSummaryPanel({ pkg }: { pkg: NetworkPackage }) {
  const s = pkg.stats;
  return (
    <section aria-label="Loaded network">
      <h2>Loaded network</h2>
      <dl className="stats">
        <dt>Area</dt>
        <dd>{formatKm2(bboxAreaKm2(pkg.bbox))} km²</dd>
        <dt>Links</dt>
        <dd>{s.links}</dd>
        <dt>Lanes</dt>
        <dd>{s.lanes}</dd>
        <dt>Junction movements</dt>
        <dd>{s.connectors}</dd>
        <dt>Signals</dt>
        <dd>{s.signals}</dd>
        <dt>OSM data as of</dt>
        <dd>{pkg.osmTimestamp ? pkg.osmTimestamp.slice(0, 10) : 'unknown'}</dd>
      </dl>
    </section>
  );
}
