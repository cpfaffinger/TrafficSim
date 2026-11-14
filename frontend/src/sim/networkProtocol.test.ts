import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  entryNodes,
  NETWORK_SNAPSHOT_STRIDE,
  readVehicle,
  VEHICLE_FLAGS,
  vehicleColor,
  vehicleCount,
} from './networkProtocol';

describe('network snapshot decoding', () => {
  it('reads vehicles with the stride-9 layout', () => {
    const snapshot = new Float32Array([1, 2, 3, 0.5, 10, 4.5, 2, 1, 42, 0, 0, 0, 0, 0, 12, 4, 7]);
    expect(() => vehicleCount(snapshot)).toThrow(/multiple/);
    const full = new Float32Array(NETWORK_SNAPSHOT_STRIDE * 2);
    full.set([1, 2, 3, 0.5, 10, 12, 2, 1, 42, 5, 6, 0, 0, 0, 2, 9, 0, 7]);
    expect(vehicleCount(full)).toBe(2);
    expect(readVehicle(full, 0)).toEqual({ x: 1, y: 2, z: 3, heading: 0.5, speed: 10, length: 12, vehicleClass: 'truck', flags: 1, id: 42 });
    expect(readVehicle(full, 1).vehicleClass).toBe('car'); // unknown class id falls back
  });

  it('colours vehicles by state and speed', () => {
    expect(vehicleColor({ speed: 20, flags: VEHICLE_FLAGS.braking })).toEqual([0.86, 0.18, 0.16]);
    expect(vehicleColor({ speed: 1, flags: 0 })[0]).toBeCloseTo(0.93);
    expect(vehicleColor({ speed: 5, flags: 0 })[1]).toBeCloseTo(0.78);
    expect(vehicleColor({ speed: 20, flags: VEHICLE_FLAGS.inJunction })[2]).toBeCloseTo(0.86);
  });
});

describe('config and entries', () => {
  it('builds a clamped config', () => {
    const config = JSON.parse(buildConfig({ vehiclesPerHour: 9999, truckShare: 0.9, heterogeneity: -1 }));
    expect(config.defaultDemand).toBe(5000);
    expect(config.vehicleMix.truck).toBe(0.5);
    expect(config.vehicleMix.car).toBe(0.4);
    expect(config.heterogeneity).toBe(0);
    expect(JSON.parse(buildConfig({ vehiclesPerHour: Number.NaN, truckShare: 0.1, heterogeneity: 0.1 })).defaultDemand).toBe(0);
  });

  it('finds boundary entry nodes', () => {
    const pkg = {
      nodes: [
        { id: 'n0', control: 'signal' },
        { id: 'n1', control: 'boundary' },
        { id: 'n2', control: 'boundary' },
      ],
      links: [{ from: 'n1' }, { from: 'n0' }],
    };
    expect(entryNodes(pkg)).toEqual(['n1']);
  });
});
