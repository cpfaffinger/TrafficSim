import { describe, expect, it } from 'vitest';
import type { VehicleInfo } from '../sim/networkProtocol';
import { duration, inspectVehicle } from './vehicleInspect';

const info: VehicleInfo = {
  id: 42,
  vehicleType: 'articulatedTruck',
  class: 'truck',
  length: 16.5,
  width: 2.55,
  height: 4,
  weight: 40,
  depart: 10,
  travelTime: 125,
  distance: 1250,
  speed: 8.3,
  speedLimit: 13.9,
  lostTime: 47,
  stoppedTime: 30,
  stops: 2,
  waiting: 12,
  link: 'l2',
  onConnector: false,
  route: ['l1', 'l2', 'l3'],
  routePos: 1,
  familiar: false,
};

describe('vehicle inspector (#125)', () => {
  it('formats durations', () => {
    expect(duration(0)).toBe('0:00');
    expect(duration(125)).toBe('2:05');
    expect(duration(3725)).toBe('1:02:05');
  });

  it('shows type, trip and route with street names', () => {
    const names: Record<string, string> = { l1: 'Ringstraße', l3: 'B3' };
    const model = inspectVehicle(info, (id) => names[id] ?? null);
    const field = (label: string) => model.sections.flatMap((s) => s.fields).find((f) => f.label === label)?.value;
    expect(model.title).toBe('Vehicle 42');
    expect(field('Type')).toBe('articulated truck');
    expect(field('Weight')).toBe('40.0 t');
    expect(field('Travelling for')).toBe('2:05');
    expect(field('Mean speed')).toBe('36 km/h');
    expect(field('Delay')).toBe('0:47');
    expect(field('Stopped')).toBe('0:30 in 2 stops');
    expect(field('Waiting at stop line')).toBe('0:12');
    expect(field('From')).toBe('Ringstraße');
    expect(field('Now on')).toBe('l2');
    expect(field('To')).toBe('B3');
    expect(field('Progress')).toBe('link 2 of 3 · 1 to go');
    expect(inspectVehicle(info, () => null, true).title).toBe('Vehicle 42 (left the network)');
  });
});
