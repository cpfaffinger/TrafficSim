import { hourlyFactors, HOUR, type TimeCurve } from '../curves';
import { formatClock } from '../model';

export interface CurveChartProps {
  name: string;
  /** Null: constant (no curve). */
  curve: TimeCurve | null;
  /** Scenario window shaded behind the bars. */
  window?: { start: number; duration: number };
}

const W = 240;
const H = 56;
const BAR = 10;

/** Hours of the day touched by the window (wrapping past midnight). */
function windowHours(start: number, duration: number): Set<number> {
  const hours = new Set<number>();
  const first = Math.floor(start / HOUR);
  const last = Math.ceil((start + Math.max(duration, 1)) / HOUR);
  for (let h = first; h < last && hours.size < 24; h++) hours.add(((h % 24) + 24) % 24);
  return hours;
}

/** Bar chart of a time-of-day curve: mean factor per hour, scenario window shaded, tooltip per bar. */
export function CurveChart({ name, curve, window }: CurveChartProps) {
  const values = hourlyFactors(curve);
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  const shaded = window ? windowHours(window.start, window.duration) : new Set<number>();
  return (
    <figure className="curve-chart">
      <svg viewBox={`0 0 ${W} ${H + 12}`} role="img" aria-label={`Curve ${name}: hourly factors, peak ${values[peak]!.toFixed(2)} at ${formatClock(peak * HOUR)}`}>
        {[...shaded].map((h) => (
          <rect key={`w${h}`} className="curve-window" x={h * BAR} y={0} width={BAR} height={H} />
        ))}
        <line className="curve-axis" x1={0} x2={W} y1={H} y2={H} />
        {values.map((v, h) => {
          const height = Math.max(v > 0 ? 1 : 0, (v / max) * (H - 4));
          return (
            <g key={h}>
              <rect className="curve-bar" x={h * BAR + 1} y={H - height} width={BAR - 2} height={height} rx={1.5} />
              <rect className="curve-hit" x={h * BAR} y={0} width={BAR} height={H}>
                <title>{`${formatClock(h * HOUR)}–${formatClock((h + 1) * HOUR)}: ${v.toFixed(2)}`}</title>
              </rect>
            </g>
          );
        })}
        {[0, 6, 12, 18, 24].map((h) => (
          <text key={h} className="curve-tick" x={Math.min(h * BAR, W - 1)} y={H + 10} textAnchor={h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}>
            {h}h
          </text>
        ))}
      </svg>
    </figure>
  );
}
