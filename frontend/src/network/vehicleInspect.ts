import type { InspectorModel } from './inspect';
import type { VehicleEvent, VehicleInfo } from '../sim/networkProtocol';

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

const EVENT_LABEL: Record<VehicleEvent['kind'], string> = {
  accepted: 'navi detour taken',
  ignored: 'navi detour ignored',
  commuter: 'commuter re-planned',
  missedTurn: 'missed turn, re-routed',
};

/** Whether the route the vehicle drives now differs from the one it started with (#129). */
export function tookDetour(info: VehicleInfo): boolean {
  const planned = [...info.trail.slice(0, -1), ...info.route.slice(info.routePos)];
  return planned.join() !== info.originalRoute.join();
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
          { label: 'From', value: place(info.trail[0] ?? info.route[0]) },
          { label: info.onConnector ? 'Entering' : 'Now on', value: place(info.link) },
          { label: 'To', value: place(info.route[info.route.length - 1]) },
          { label: 'Progress', value: `link ${info.routePos + 1} of ${info.route.length} · ${remaining} to go` },
          { label: 'Driven', value: `${info.trail.length} link${info.trail.length === 1 ? '' : 's'}` },
          { label: 'Detour', value: tookDetour(info) ? 'yes, off its original route' : 'no, original route' },
        ],
      },
      {
        title: 'Navigation',
        fields: [
          {
            label: 'Device',
            value: info.navi ? `navi, follows ${Math.round(info.compliance * 100)} % of its proposals` : info.familiar ? 'none (knows the network)' : 'none',
          },
          {
            label: 'Proposals',
            value: `${count(info.events, 'accepted')} followed, ${count(info.events, 'ignored')} ignored`,
          },
          ...info.events.map((e, i) => ({
            label: `${i + 1}. at ${duration(e.time)}`,
            value: `${EVENT_LABEL[e.kind]} on ${place(e.link)}${e.gain > 0 ? ` (saves ~${Math.round(e.gain)} s)` : ''}`,
          })),
        ],
      },
    ],
  };
}

const count = (events: readonly VehicleEvent[], kind: VehicleEvent['kind']) => events.filter((e) => e.kind === kind).length;
