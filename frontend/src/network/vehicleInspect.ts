import type { InspectorModel } from './inspect';
import type { VehicleInfo } from '../sim/networkProtocol';

const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(m < 10 ? 1 : 0)} m`);
const kmh = (ms: number) => `${Math.round(ms * 3.6)} km/h`;

/** Seconds as `m:ss` (or `h:mm:ss`). */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Inspector model of a simulated vehicle (#125): type and dimensions, the trip so far and its
 * route. `linkName` resolves link ids to street names for origin, position and destination.
 */
export function inspectVehicle(info: VehicleInfo, linkName: (id: string) => string | null, arrived = false): InspectorModel {
  const place = (id: string | undefined) => (id === undefined ? '—' : (linkName(id) ?? id));
  const meanSpeed = info.travelTime > 0 ? info.distance / info.travelTime : 0;
  const remaining = Math.max(0, info.route.length - 1 - info.routePos);
  return {
    title: `Vehicle ${info.id}${arrived ? ' (left the network)' : ''}`,
    kind: 'vehicle',
    sections: [
      {
        title: 'Vehicle',
        fields: [
          { label: 'Type', value: words(info.vehicleType) },
          { label: 'Class', value: info.class },
          { label: 'Length × width', value: `${info.length.toFixed(1)} × ${info.width.toFixed(2)} m` },
          { label: 'Height', value: `${info.height.toFixed(1)} m` },
          { label: 'Weight', value: `${info.weight.toFixed(1)} t` },
          { label: 'Driver', value: info.familiar ? 'commuter (knows the network)' : 'visitor' },
        ],
      },
      {
        title: 'Trip',
        fields: [
          { label: 'Travelling for', value: duration(info.travelTime) },
          { label: 'Distance', value: metres(info.distance) },
          { label: 'Mean speed', value: kmh(meanSpeed) },
          { label: 'Speed now', value: `${kmh(info.speed)} (limit ${kmh(info.speedLimit)})` },
          { label: 'Delay', value: duration(info.lostTime) },
          { label: 'Stopped', value: `${duration(info.stoppedTime)} in ${info.stops} stop${info.stops === 1 ? '' : 's'}` },
          ...(info.waiting > 0.5 ? [{ label: 'Waiting at stop line', value: duration(info.waiting) }] : []),
        ],
      },
      {
        title: 'Route',
        fields: [
          { label: 'From', value: place(info.route[0]) },
          { label: info.onConnector ? 'Entering' : 'Now on', value: place(info.link) },
          { label: 'To', value: place(info.route[info.route.length - 1]) },
          { label: 'Progress', value: `link ${info.routePos + 1} of ${info.route.length} · ${remaining} to go` },
        ],
      },
    ],
  };
}
