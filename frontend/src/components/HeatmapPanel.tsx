import { formatClock } from './SimulationPanel';
import { HEATMAP_METRICS, METRIC_INFO, type HeatmapMetric } from '../metrics/heatmapMetrics';

export interface HeatmapPanelProps {
  enabled: boolean;
  metric: HeatmapMetric;
  smooth: boolean;
  /** Available bucket range, null while no bucket has finished yet. */
  range: [number, number] | null;
  /** Shown bucket (null = latest / live). */
  bucket: number | null;
  live: boolean;
  replaying: boolean;
  timeOfDay: (bucket: number) => number;
  onEnabled: (enabled: boolean) => void;
  onMetric: (metric: HeatmapMetric) => void;
  onSmooth: (smooth: boolean) => void;
  onBucket: (bucket: number) => void;
  onLive: () => void;
  onReplay: (replaying: boolean) => void;
  /** Label of an active A/B comparison (#74); the panel then shows a diverging legend. */
  comparing?: string | null;
  onExitCompare?: () => void;
}

/** Heatmap controls (#59) and the timeline with replay of aggregated buckets (#60). */
export function HeatmapPanel(props: HeatmapPanelProps) {
  return (
    <section aria-label="Heatmap" className="heatmap-panel">
      <h2>Heatmap</h2>
      <label className="checkbox">
        <input type="checkbox" checked={props.enabled} onChange={(e) => props.onEnabled(e.target.checked)} /> Show heatmap
      </label>
      <div className="sim-settings">
        <label>
          Metric{' '}
          <select value={props.metric} onChange={(e) => props.onMetric(e.target.value as HeatmapMetric)}>
            {HEATMAP_METRICS.map((m) => (
              <option key={m} value={m}>
                {METRIC_INFO[m].label}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={props.smooth} onChange={(e) => props.onSmooth(e.target.checked)} /> Smooth
        </label>
      </div>
      {props.comparing ? (
        <>
          <p className="small">Comparing {props.comparing} (mean over the run).</p>
          <div className="legend" aria-label={`${METRIC_INFO[props.metric].label} difference legend`}>
            <span>B worse</span>
            <span className="legend-bar diverging" />
            <span>B better</span>
          </div>
          <button type="button" onClick={props.onExitCompare}>
            Exit comparison
          </button>
        </>
      ) : (
        <HeatmapTimeline {...props} />
      )}
    </section>
  );
}

function HeatmapTimeline(props: HeatmapPanelProps) {
  const { range } = props;
  const shown = props.bucket ?? range?.[1] ?? null;
  const info = METRIC_INFO[props.metric];
  return (
    <>
      <div className="legend" aria-label={`${info.label} legend`}>
        <span>{info.higherIsBetter ? 'low' : '0'}</span>
        <span className={`legend-bar ${info.higherIsBetter ? 'good-high' : 'good-low'}`} />
        <span>
          {info.unit === '%' ? `${info.max * 100} %` : `${info.max} ${info.unit}`}
          {info.higherIsBetter ? '' : '+'}
        </span>
      </div>
      {range ? (
        <div className="timeline">
          <input
            type="range"
            aria-label="Timeline"
            min={range[0]}
            max={range[1]}
            step={1}
            value={shown ?? range[1]}
            onChange={(e) => props.onBucket(Number(e.target.value))}
          />
          <div className="timeline-controls">
            <span>{shown !== null ? formatClock(props.timeOfDay(shown) % 86400) : '–'}</span>
            <button type="button" onClick={() => props.onReplay(!props.replaying)}>
              {props.replaying ? 'Stop replay' : 'Replay'}
            </button>
            <button type="button" onClick={props.onLive} disabled={props.live}>
              Live
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">Play the simulation; the first 30 s bucket appears after 30 simulated seconds.</p>
      )}
    </>
  );
}
