import type { RunKpi } from '../runs/runStats';
import { transitKpis } from './model';

/** Run KPIs of the bus lines (#85); null for runs without transit lines, which hides the rows. */
export const TRANSIT_KPIS: readonly RunKpi[] = [
  { key: 'busTrips', label: 'Bus trips', unit: '', digits: 0, higherIsBetter: true, get: (s) => transitKpis(s).trips },
  { key: 'busTravelTime', label: 'Bus travel time', unit: 's', digits: 0, higherIsBetter: false, get: (s) => transitKpis(s).travelTime },
  { key: 'busDwell', label: 'Mean dwell', unit: 's', digits: 1, higherIsBetter: false, get: (s) => transitKpis(s).dwell },
  { key: 'busHeadwayCv', label: 'Headway irregularity (CV)', unit: '', digits: 2, higherIsBetter: false, get: (s) => transitKpis(s).headwayCv },
  { key: 'busMissedStops', label: 'Missed stops', unit: '', digits: 0, higherIsBetter: false, get: (s) => transitKpis(s).missedStops },
];
