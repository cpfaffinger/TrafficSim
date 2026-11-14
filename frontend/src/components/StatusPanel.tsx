import type { BackendStatus } from '../api/client';

export interface StatusPanelProps {
  status: BackendStatus | 'unknown';
  version: string | null;
  simTime: number;
  meanSpeed: number;
  vehicleCount: number;
}

const statusLabel: Record<StatusPanelProps['status'], string> = {
  ok: 'online',
  degraded: 'degraded (database)',
  down: 'offline',
  unknown: 'checking…',
};

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function StatusPanel({ status, version, simTime, meanSpeed, vehicleCount }: StatusPanelProps) {
  return (
    <section aria-label="Status">
      <h2>Status</h2>
      <dl className="stats">
        <dt>Backend</dt>
        <dd>
          <span className={`status-dot ${status}`} aria-hidden="true" />
          {statusLabel[status]}
        </dd>
        <dt>Version</dt>
        <dd>{version ?? '–'}</dd>
        <dt>Simulated time</dt>
        <dd>{formatDuration(simTime)}</dd>
        <dt>Vehicles</dt>
        <dd>{vehicleCount}</dd>
        <dt>Mean speed</dt>
        <dd>{(meanSpeed * 3.6).toFixed(1)} km/h</dd>
      </dl>
    </section>
  );
}
