import * as THREE from 'three';
import { buildBasemapMeshes } from '../basemap/basemapMeshes';
import { loadBasemap } from '../basemap/loader';
import { frameRect } from '../lib/rtsCamera';
import { nextPick, uniqueOwners, type PreviousPick } from '../lib/picking';
import { fromScene, LocalTangentPlane, toScene } from '../network/geo';
import type { MeshData, PickTarget } from '../network/meshData';
import { buildNetworkMeshes, type NetworkMeshes } from '../network/networkMeshes';
import type { BBox, GeoOrigin, NetworkPackage } from '../network/types';
import { disposeGroup, subsetGeometry, toBufferGeometry } from './geometry';
import { RtsCameraController } from './RtsCameraController';

/** Positron-inspired palette. */
const COLORS = {
  sky: 0xdfe6ec,
  ground: 0xeceae4,
  landuse: 0xe2e0d9,
  park: 0xcfe0bd,
  water: 0xaecbe0,
  building: 0xf4f1ea,
  asphalt: 0x5a5f66,
  marking: 0xf7f7f2,
  concrete: 0xbab6ad,
  tunnel: 0x4f7cac,
  highlight: 0xff8a00,
  area: 0x3e63dd,
};

export type BasemapStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface NetworkSceneCallbacks {
  onPick?: (target: PickTarget | null) => void;
  onBasemap?: (status: BasemapStatus, attribution: string | null) => void;
}

/** A click on the scene: the ground point under the cursor in package ENU metres (null above the horizon). */
export interface SceneClick {
  ground: [east: number, north: number] | null;
}

/** Returns true when the click was consumed (e.g. by a drawing tool) and must not pick. */
export type SceneClickHandler = (click: SceneClick) => boolean;

interface Pickable {
  mesh: THREE.Mesh;
  data: MeshData;
}

/**
 * Imperative Three.js scene for imported networks (ADR-0008): ground and basemap, merged road,
 * marking and structure meshes, picking with highlight, RTS camera. Rebuilt per package; all GPU
 * resources of the previous package are disposed.
 */
export class NetworkScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
  private readonly controls: RtsCameraController;
  private readonly basemapGroup = new THREE.Group();
  private readonly networkGroup = new THREE.Group();
  private readonly tunnelGroup = new THREE.Group();
  private readonly overlayGroup = new THREE.Group();
  private readonly highlightGroup = new THREE.Group();
  private readonly lastCamera = new THREE.Matrix4();
  private readonly ground: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly clock = new THREE.Clock();
  private frameHandle = 0;
  private dirty = true;
  private meshes: NetworkMeshes | null = null;
  private pickables: Pickable[] = [];
  private previousPick: PreviousPick | null = null;
  private basemapAbort: AbortController | null = null;
  private origin: GeoOrigin | null = null;
  private basemapKey = '';
  private clickHandler: SceneClickHandler | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: NetworkSceneCallbacks = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.setAttribute('aria-label', 'Road network 3D view. Drag to pan, right-drag to rotate, wheel to zoom, click to inspect.');
    this.renderer.domElement.setAttribute('role', 'application');
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(COLORS.sky);
    this.scene.fog = new THREE.Fog(COLORS.sky, 4000, 12000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b4a8, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-300, 600, 250);
    this.scene.add(sun);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ color: COLORS.ground }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.3;
    this.ground.scale.set(20_000, 20_000, 1);
    this.scene.add(this.ground, this.basemapGroup, this.networkGroup, this.tunnelGroup, this.overlayGroup, this.highlightGroup);

    this.controls = new RtsCameraController(this.camera, this.renderer.domElement, (x, y) => this.pick(x, y));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  /**
   * Replaces the displayed network. Basemap tiles are (re)loaded around it in the background.
   * `keepCamera` keeps the view (e.g. when showing an edited version of the same area).
   */
  loadPackage(pkg: NetworkPackage, options: { keepCamera?: boolean } = {}): void {
    const keepCamera = options.keepCamera === true && this.meshes !== null;
    this.clearNetwork();
    this.origin = pkg.origin;
    this.meshes = buildNetworkMeshes(pkg);
    const m = this.meshes;

    const surface = this.addMesh(this.networkGroup, m.surface, new THREE.MeshLambertMaterial({ color: COLORS.asphalt }));
    const markings = this.addMesh(
      this.networkGroup,
      m.markings,
      new THREE.MeshLambertMaterial({ color: COLORS.marking, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    markings.renderOrder = 1;
    const structures = this.addMesh(this.networkGroup, m.structures, new THREE.MeshLambertMaterial({ color: COLORS.concrete }));
    const ghost = (opacity: number, color: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    const tunnel = this.addMesh(this.tunnelGroup, m.tunnelSurface, ghost(0.35, COLORS.tunnel));
    tunnel.renderOrder = 5;
    const tunnelMarkings = this.addMesh(this.tunnelGroup, m.tunnelMarkings, ghost(0.5, COLORS.marking));
    tunnelMarkings.renderOrder = 6;
    this.pickables = [
      { mesh: surface, data: m.surface },
      { mesh: structures, data: m.structures },
      { mesh: tunnel, data: m.tunnelSurface },
    ];

    const [minE, minN, maxE, maxN] = m.extent;
    const rect: [number, number, number, number] = [minE, -maxN, maxE, -minN];
    const margin = 500;
    this.controls.limits = { ...this.controls.limits, bounds: [rect[0] - margin, rect[1] - margin, rect[2] + margin, rect[3] + margin] };
    if (!keepCamera) this.controls.setState(frameRect(rect, (this.camera.fov * Math.PI) / 180, this.camera.aspect, this.controls.limits));
    this.loadBasemapFor(pkg.bbox, pkg.origin);
    this.dirty = true;
  }

  /** Shows a proposed import area (outline) with basemap around it; replaces nothing if a package is shown. */
  showAreaPreview(bbox: BBox | null): void {
    disposeGroup(this.overlayGroup);
    this.dirty = true;
    if (!bbox) return;
    if (!this.meshes) {
      this.origin = { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 };
    }
    const plane = new LocalTangentPlane(this.origin!);
    const [w, s] = plane.toLocal(bbox[0], bbox[1]);
    const [e, n] = plane.toLocal(bbox[2], bbox[3]);
    const corners = [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ].map(([x, y]) => new THREE.Vector3(...toScene([x!, y!, 1])));
    const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: COLORS.area }));
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(e - w, n - s),
      new THREE.MeshBasicMaterial({ color: COLORS.area, transparent: true, opacity: 0.08, depthWrite: false }),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.set((w + e) / 2, 0.5, -(s + n) / 2);
    this.overlayGroup.add(outline, fill);
    this.controls.limits = { ...this.controls.limits, bounds: [w - 3000, -n - 3000, e + 3000, -s + 3000] };
    this.controls.setState(frameRect([w, -n, e, -s], (this.camera.fov * Math.PI) / 180, this.camera.aspect, this.controls.limits));
    if (!this.meshes) this.loadBasemapFor(bbox, this.origin!);
  }

  setTunnelsVisible(visible: boolean): void {
    this.tunnelGroup.visible = visible;
    this.dirty = true;
  }

  setBasemapVisible(visible: boolean): void {
    this.basemapGroup.visible = visible;
    this.dirty = true;
  }

  /** Highlights the target (or clears the highlight). */
  select(target: PickTarget | null): void {
    disposeGroup(this.highlightGroup);
    this.dirty = true;
    if (!target || !this.meshes) return;
    const owner = this.meshes.registry.indexOf(target);
    if (owner === undefined) return;
    const material = new THREE.MeshBasicMaterial({
      color: COLORS.highlight,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const { data } of this.pickables) {
      const tris = data.trianglesOf(owner);
      if (tris.length === 0) continue;
      const mesh = new THREE.Mesh(subsetGeometry(data, tris), material.clone());
      mesh.renderOrder = 10;
      this.highlightGroup.add(mesh);
    }
    material.dispose();
  }

  /** Routes clicks to a tool before picking (null restores plain picking). */
  setClickHandler(handler: SceneClickHandler | null): void {
    this.clickHandler = handler;
  }

  /** Adds editor overlays (drawn above the network, disposed by their owner). */
  addOverlay(object: THREE.Object3D): void {
    this.scene.add(object);
    this.dirty = true;
  }

  removeOverlay(object: THREE.Object3D): void {
    this.scene.remove(object);
    this.dirty = true;
  }

  /** Requests a redraw after overlays changed. */
  invalidate(): void {
    this.dirty = true;
  }

  resetView(): void {
    if (!this.meshes) return;
    const [minE, minN, maxE, maxN] = this.meshes.extent;
    this.controls.setState(frameRect([minE, -maxN, maxE, -minN], (this.camera.fov * Math.PI) / 180, this.camera.aspect, this.controls.limits));
    this.dirty = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.basemapAbort?.abort();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const g of [this.basemapGroup, this.networkGroup, this.tunnelGroup, this.overlayGroup, this.highlightGroup]) disposeGroup(g);
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private addMesh(group: THREE.Group, data: MeshData, material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(toBufferGeometry(data), material);
    mesh.matrixAutoUpdate = false;
    mesh.visible = data.triangleCount > 0;
    group.add(mesh);
    return mesh;
  }

  private clearNetwork(): void {
    disposeGroup(this.networkGroup);
    disposeGroup(this.tunnelGroup);
    disposeGroup(this.highlightGroup);
    disposeGroup(this.overlayGroup);
    this.pickables = [];
    this.meshes = null;
    this.previousPick = null;
  }

  private loadBasemapFor(bbox: BBox, origin: GeoOrigin): void {
    const key = `${bbox.join(',')}@${origin.lat},${origin.lon}`;
    if (key === this.basemapKey) return;
    this.basemapKey = key;
    this.basemapAbort?.abort();
    const abort = new AbortController();
    this.basemapAbort = abort;
    disposeGroup(this.basemapGroup);
    this.callbacks.onBasemap?.('loading', null);
    loadBasemap({ bbox, origin, signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        const meshes = buildBasemapMeshes(result.polygons);
        const lambert = (color: number) => new THREE.MeshLambertMaterial({ color });
        this.addMesh(this.basemapGroup, meshes.landuse, lambert(COLORS.landuse));
        this.addMesh(this.basemapGroup, meshes.park, lambert(COLORS.park));
        this.addMesh(this.basemapGroup, meshes.water, lambert(COLORS.water));
        this.addMesh(this.basemapGroup, meshes.building, new THREE.MeshLambertMaterial({ color: COLORS.building, flatShading: true }));
        this.dirty = true;
        this.callbacks.onBasemap?.('ready', result.attribution);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        this.basemapKey = '';
        this.callbacks.onBasemap?.('unavailable', null);
      });
  }

  private pick(clientX: number, clientY: number): void {
    if (this.clickHandler) {
      const g = this.controls.groundAt(clientX, clientY);
      const ground = g ? fromScene(g[0], 0, g[1]) : null;
      if (this.clickHandler({ ground: ground ? [ground[0], ground[1]] : null })) return;
    }
    if (!this.meshes) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = this.pickables.filter((p) => p.mesh.visible && (p.mesh.parent?.visible ?? true));
    const hits = this.raycaster.intersectObjects(
      targets.map((p) => p.mesh),
      false,
    );
    const owners = uniqueOwners(
      hits.map((h) => {
        const p = targets.find((t) => t.mesh === h.object);
        return { owner: p && h.faceIndex != null ? (p.data.owners[h.faceIndex] ?? -1) : -1, distance: h.distance };
      }),
    );
    const owner = nextPick(owners, { x: clientX, y: clientY }, this.previousPick);
    this.previousPick = owner === null ? null : { x: clientX, y: clientY, owner };
    const target = owner === null ? null : (this.meshes.registry.targets[owner] ?? null);
    this.select(target);
    this.callbacks.onPick?.(target);
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private animate = (): void => {
    this.frameHandle = requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.controls.update(dt)) this.dirty = true;
    // Render on demand: camera movement, new content or resize. Pointer moves mark dirty via the camera.
    const fogFar = Math.max(4000, this.controls.state.distance * 12);
    const fog = this.scene.fog as THREE.Fog;
    if (fog.far !== fogFar) {
      fog.far = fogFar;
      fog.near = fogFar * 0.35;
      this.dirty = true;
    }
    if (this.dirty || this.cameraMoved()) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  private cameraMoved(): boolean {
    if (this.lastCamera.equals(this.camera.matrixWorld)) return false;
    this.lastCamera.copy(this.camera.matrixWorld);
    return true;
  }
}
