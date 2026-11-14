import * as THREE from 'three';
import { toScene } from '../network/geo';
import type { NetworkPackage } from '../network/types';
import { busColor, NETWORK_SNAPSHOT_STRIDE, VEHICLE_CLASSES, VEHICLE_DIMENSIONS, vehicleColor } from '../sim/networkProtocol';
import { aspectColor, signalMarkers, type SignalMarker } from '../sim/signalMarkers';

/**
 * Live simulation overlay (#47): one InstancedMesh for all vehicles (unit box scaled per instance)
 * and one for signal heads. Capacity grows on demand; nothing is allocated per frame otherwise.
 */
export class SimulationLayer {
  readonly group = new THREE.Group();
  private vehicles: THREE.InstancedMesh;
  private signals: THREE.InstancedMesh | null = null;
  private markers: SignalMarker[] = [];
  /** Enlargement of vehicles when the camera is far away (#80). */
  vehicleScale = 1;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();
  private readonly box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private readonly material = new THREE.MeshLambertMaterial();

  constructor() {
    this.vehicles = this.createVehicles(1024);
  }

  /** Prepares signal heads for a package; group order as reported by the sim core. */
  prepare(pkg: NetworkPackage, signalGroupIds: readonly string[]): void {
    this.disposeSignals();
    this.markers = signalMarkers(pkg, signalGroupIds);
    if (this.markers.length === 0) return;
    const sphere = new THREE.SphereGeometry(0.6, 10, 8);
    this.signals = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial(), this.markers.length);
    this.markers.forEach((m, i) => {
      this.matrix.makeTranslation(...toScene(m.position));
      this.signals!.setMatrixAt(i, this.matrix);
      this.signals!.setColorAt(i, this.color.setRGB(...aspectColor(0)));
    });
    this.group.add(this.signals);
  }

  updateVehicles(snapshot: Float32Array): void {
    const count = snapshot.length / NETWORK_SNAPSHOT_STRIDE;
    if (count > this.capacity) {
      this.group.remove(this.vehicles);
      this.vehicles.dispose();
      this.vehicles = this.createVehicles(Math.max(count, this.capacity * 2));
    }

    for (let i = 0; i < count; i++) {
      const o = i * NETWORK_SNAPSHOT_STRIDE;
      const cls = VEHICLE_CLASSES[Math.round(snapshot[o + 6]!)] ?? 'car';
      const dims = VEHICLE_DIMENSIONS[cls];
      const [x, y, z] = toScene([snapshot[o]!, snapshot[o + 1]!, snapshot[o + 2]! + 0.05]);
      this.position.set(x, y, z);
      // Heading is counter-clockwise from east in ENU; scene rotation about +y has the same sense.
      this.quaternion.setFromAxisAngle(this.up, snapshot[o + 3]!);
      const s = this.vehicleScale;
      this.scale.set(Math.max(0.5, snapshot[o + 5]!) * Math.min(2, s), dims.height * s, dims.width * s);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.vehicles.setMatrixAt(i, this.matrix);
      const flags = Math.round(snapshot[o + 7]!);
      this.vehicles.setColorAt(i, this.color.setRGB(...(cls === 'bus' ? busColor(flags) : vehicleColor({ speed: snapshot[o + 4]!, flags }))));
    }
    this.vehicles.count = count;
    this.vehicles.instanceMatrix.needsUpdate = true;
    if (this.vehicles.instanceColor) this.vehicles.instanceColor.needsUpdate = true;
  }

  updateSignals(aspects: Uint8Array): void {
    if (!this.signals) return;
    this.markers.forEach((m, i) => this.signals!.setColorAt(i, this.color.setRGB(...aspectColor(aspects[m.groupIndex] ?? 0))));
    if (this.signals.instanceColor) this.signals.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.vehicles.count = 0;
    this.disposeSignals();
  }

  dispose(): void {
    this.clear();
    this.vehicles.dispose();
    this.box.dispose();
    this.material.dispose();
  }

  private capacity = 0;

  private createVehicles(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.box, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this.color.setRGB(1, 1, 1));
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.capacity = capacity;
    this.group.add(mesh);
    return mesh;
  }

  private disposeSignals(): void {
    if (this.signals) {
      this.group.remove(this.signals);
      this.signals.geometry.dispose();
      (this.signals.material as THREE.Material).dispose();
      this.signals.dispose();
      this.signals = null;
    }
    this.markers = [];
  }
}
