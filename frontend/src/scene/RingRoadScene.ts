import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { speedColor } from '../lib/colorScale';
import { ringPose, ringRadius } from '../lib/ringGeometry';
import { SNAPSHOT_STRIDE } from '../sim/protocol';

const ROAD_WIDTH = 4;
const MAX_VEHICLES = 512;

/** Imperative Three.js scene for the ring-road demo (ADR-0008). */
export class RingRoadScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
  private readonly controls: OrbitControls;
  private readonly vehicles: THREE.InstancedMesh;
  private road: THREE.Mesh | null = null;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();
  private readonly resizeObserver: ResizeObserver;
  private frameHandle = 0;
  private length = 0;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x9fb3c8);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(80, 150, 60);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(600, 64),
      new THREE.MeshLambertMaterial({ color: 0x7c9a6b }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    this.scene.add(ground);

    const body = new THREE.BoxGeometry(4.5, 1.5, 1.8);
    body.translate(0, 0.75, 0);
    this.vehicles = new THREE.InstancedMesh(body, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_VEHICLES);
    this.vehicles.count = 0;
    this.vehicles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.vehicles);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.1;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  setRing(length: number): void {
    if (length === this.length) return;
    this.length = length;
    if (this.road) {
      this.scene.remove(this.road);
      this.road.geometry.dispose();
    }
    const r = ringRadius(length);
    this.road = new THREE.Mesh(
      new THREE.RingGeometry(r - ROAD_WIDTH / 2, r + ROAD_WIDTH / 2, 128),
      new THREE.MeshLambertMaterial({ color: 0x3a3f4b }),
    );
    this.road.rotation.x = -Math.PI / 2;
    this.scene.add(this.road);
    this.camera.position.set(0, r * 1.6, r * 1.9);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  update(snapshot: Float32Array, desiredSpeed: number): void {
    const count = Math.min(MAX_VEHICLES, snapshot.length / SNAPSHOT_STRIDE);
    for (let i = 0; i < count; i++) {
      const position = snapshot[i * SNAPSHOT_STRIDE]!;
      const speed = snapshot[i * SNAPSHOT_STRIDE + 1]!;
      const pose = ringPose(position, this.length);
      this.quaternion.setFromAxisAngle(this.up, pose.heading);
      this.matrix.compose(new THREE.Vector3(pose.x, 0, pose.z), this.quaternion, new THREE.Vector3(1, 1, 1));
      this.vehicles.setMatrixAt(i, this.matrix);
      const [r, g, b] = speedColor(speed / desiredSpeed);
      this.vehicles.setColorAt(i, this.color.setRGB(r, g, b, THREE.SRGBColorSpace));
    }
    this.vehicles.count = count;
    this.vehicles.instanceMatrix.needsUpdate = true;
    if (this.vehicles.instanceColor) this.vehicles.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.frameHandle = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
