import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NETWORK_SNAPSHOT_STRIDE } from '../sim/networkProtocol';
import { SimulationLayer } from './SimulationLayer';

/** Snapshot rows: x, y, z, heading, speed, length, class, flags, id. */
function snapshot(rows: number[][]): Float32Array {
  return new Float32Array(rows.flatMap((r) => r.concat(Array(NETWORK_SNAPSHOT_STRIDE - r.length).fill(0)).slice(0, NETWORK_SNAPSHOT_STRIDE)));
}

const rayDown = (east: number, north: number) => {
  const raycaster = new THREE.Raycaster();
  // Scene x = east, z = -north, y = up.
  raycaster.set(new THREE.Vector3(east, 100, -north), new THREE.Vector3(0, -1, 0));
  return raycaster;
};

describe('SimulationLayer (#125)', () => {
  it('finds the vehicle under a ray, also after vehicles moved', () => {
    const layer = new SimulationLayer();
    layer.updateVehicles(snapshot([[0, 0, 0, 0, 5, 4.5, 0, 0, 7], [50, 0, 0, 0, 5, 4.5, 0, 0, 8]]));
    expect(layer.vehicleAt(rayDown(0, 0))).toBe(7);
    expect(layer.vehicleAt(rayDown(50, 0))).toBe(8);
    expect(layer.vehicleAt(rayDown(25, 0))).toBeNull();
    // Moved far away from where the first pick saw them.
    layer.updateVehicles(snapshot([[500, 300, 0, 0, 5, 4.5, 0, 0, 7]]));
    expect(layer.vehicleAt(rayDown(500, 300))).toBe(7);
  });

  it('knows where a vehicle is (focus and follow, #130)', () => {
    const layer = new SimulationLayer();
    layer.updateVehicles(snapshot([[12, -4, 0, 0, 5, 4.5, 0, 0, 3]]));
    expect(layer.positionOf(3)).toEqual([12, -4]);
    expect(layer.positionOf(4)).toBeNull();
  });
});
