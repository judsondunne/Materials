import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GeometryType, LoadState } from '../product/types';
import type { CameraPreset, OverlayState, VisualizationMode } from '../state/appState';
import { boxOf, fitGeometry } from './framing';
import { buildComponent, type GeometryBundle, type Quality } from './geometry';
import {
  applyLoad,
  createComponentMaterial,
  createUniforms,
  createWireMaterial,
  MODE_INDEX,
  type ComponentUniforms,
} from './material';
import { Overlays } from './overlays';
import { sanitiseParams, warp, type Vec3, type WarpParams } from './warp';

/**
 * The component viewport.
 *
 * One WebGL context, one component, render-on-demand. Nothing is rebuilt while a
 * slider moves: the geometry is generated once per program, the deformation is a
 * uniform update, and a frame is drawn only when something has actually changed
 * or an animation is running. That is what keeps a continuously deforming
 * component at full frame rate while the rest of the application stays
 * responsive beside it.
 *
 * The visual target is engineering visualisation: soft studio illumination from
 * a generated environment, a restrained grid, a real contact shadow, and no
 * glow. The object is meant to look measured, not lit for a game.
 */

export interface ViewportOptions {
  geometry: GeometryType;
  color: string;
  roughness: number;
  distance: number;
  fieldScale: number;
  quality?: Quality;
  /** Slow rotation when the user has not taken the camera. */
  spin?: number;
  showFloor?: boolean;
}

/**
 * Camera framing per preset: a direction, and how much room to leave around
 * the part. The distance itself is solved from the field of view and the
 * viewport's aspect rather than guessed, so a component never overflows its
 * frame on a tall window and never sits lost in the middle of a wide one.
 */
const FRAMING: Record<CameraPreset, { dir: Vec3; margin: number }> = {
  perspective: { dir: [0.82, 0.55, 1], margin: 1.16 },
  front: { dir: [0, 0.1, 1], margin: 1.14 },
  side: { dir: [1, 0.1, 0], margin: 1.14 },
  top: { dir: [0, 1, 0.0015], margin: 1.14 },
  section: { dir: [0.3, 0.32, 1], margin: 1.1 },
};

/**
 * Per-component overrides.
 *
 * The hose lies along Z, so the default three-quarter view would look straight
 * down its bore and a hose would read as a washer. Its views are rotated a
 * quarter turn: "front" shows the length, "side" looks into the bore.
 */
const FRAMING_OVERRIDES: Partial<Record<GeometryType, Partial<Record<CameraPreset, { dir: Vec3; margin: number }>>>> = {
  hose: {
    perspective: { dir: [0.92, 0.46, 0.72], margin: 1.16 },
    front: { dir: [1, 0.08, 0], margin: 1.14 },
    side: { dir: [0, 0.1, 1], margin: 1.14 },
    section: { dir: [0.55, 0.62, 0.3], margin: 1.1 },
  },
  tread: {
    perspective: { dir: [0.6, 0.72, 1], margin: 1.16 },
    section: { dir: [0.9, 0.35, 0.45], margin: 1.1 },
  },
};

const framingFor = (geometry: GeometryType, preset: CameraPreset) =>
  FRAMING_OVERRIDES[geometry]?.[preset] ?? FRAMING[preset];

/**
 * Which way the cutaway plane faces, per geometry. Each is chosen to reveal the
 * thing that matters: the seal's and bushing's cross-sections, the hose's bore
 * along its length, and the tread's block profile.
 */
const SECTION_NORMAL: Record<GeometryType, Vec3> = {
  oring: [0, 0, 1],
  bushing: [0, 0, 1],
  hose: [0, 1, 0],
  tread: [1, 0, 0],
};

/**
 * A shared do-nothing bundle, used only to satisfy definite assignment in the
 * constructor before `rebuild` installs the real one. It owns no GPU resources,
 * so it is never disposed.
 */
const EMPTY_BUNDLE: GeometryBundle = (() => {
  const empty = () => ({
    geometry: new THREE.BufferGeometry(),
    samples: [] as { p: Vec3; edge: number }[],
    regions: [] as string[],
  });
  return { ...empty(), pick: empty() };
})();

export class ComponentViewport {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  private readonly uniforms: ComponentUniforms = createUniforms();

  private bundle: GeometryBundle;
  private mesh: THREE.Mesh;
  private interior: THREE.Mesh;
  private wire: THREE.LineSegments;
  private ghost: THREE.LineSegments;
  private overlays: Overlays;
  private pickMesh: THREE.Mesh;
  private floor: THREE.Group;
  private shadow: THREE.Mesh;

  private envTexture: THREE.Texture | null = null;
  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0.001);

  private options: ViewportOptions;
  private preset: CameraPreset = 'perspective';
  private radius = 1;
  /** The current component's rest bounding box, which the camera frames against. */
  private box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  /** The point the camera orbits — the box centre, not necessarily the origin. */
  private readonly orbitTarget = new THREE.Vector3();
  /** Whether a real viewport size has been seen yet, so the first one frames. */
  private framed = false;
  /** Extra room around the exact fit, from the program's visual settings. */
  private framingSlack = 1;
  private viewWidth = 0;
  private viewHeight = 0;
  private dirty = true;
  /**
   * Whether a frame has ever reached the screen. A viewport that mounts while
   * an observer still believes it is off screen must not sit blank: the first
   * frame is always drawn, and only after that does visibility gate rendering.
   */
  private drawn = false;
  private running = true;
  private frame = 0;

  private load: LoadState | null = null;
  private amplitude = 1;
  private pickDirty = true;
  private wireBuilt = false;
  /**
   * The last overlay state pushed in. A rebuild replaces the meshes, so it has
   * to reapply this itself: the React side only pushes overlays when the user
   * changes them, and swapping the component is not that.
   */
  private overlayState: OverlayState | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private pickHandler: ((region: string | null, point: THREE.Vector3 | null) => void) | null = null;

  constructor(container: HTMLElement, options: ViewportOptions) {
    // Bound first, before anything below can reach `wake`. `rebuild` runs later
    // in this constructor and frames the camera, which wakes the loop — and an
    // unbound `tick` handed to requestAnimationFrame is invoked with no `this`.
    this.tick = this.tick.bind(this);
    this.options = options;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.canvas = this.renderer.domElement;
    // A device pixel ratio above 2 costs four times the fill for a difference
    // nobody can see on a component this size.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.localClippingEnabled = true;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.8;
    this.controls.minPolarAngle = 0.08;
    this.controls.maxPolarAngle = Math.PI - 0.08;
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
    });
    this.controls.addEventListener('change', () => {
      this.dirty = true;
      this.pushCamera();
    });

    this.scene.add(this.root);
    this.buildEnvironment();
    this.floor = this.buildFloor();
    this.shadow = this.buildShadow();
    this.scene.add(this.floor, this.shadow);

    // Empty placeholders purely so every field is definitely assigned before
    // `rebuild` runs; it builds the real component exactly once. Tessellating
    // here as well would generate — and immediately throw away — a full
    // component on every mount, which is the most expensive thing this class
    // does.
    this.bundle = EMPTY_BUNDLE;
    this.mesh = new THREE.Mesh();
    this.interior = new THREE.Mesh();
    this.wire = new THREE.LineSegments();
    this.ghost = new THREE.LineSegments();
    this.pickMesh = new THREE.Mesh();
    this.overlays = new Overlays(options.geometry);
    this.rebuild(options);

    this.wake();
  }

  // ── Construction ─────────────────────────────────────────────────────────

  private buildEnvironment(): void {
    // A generated room rather than a downloaded HDR: soft, neutral, and it ships
    // with nothing. It is what gives the compound its broad specular sheen.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.035);
    this.envTexture = env.texture;
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.82;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(2.4, 3.6, 2.2);
    const fill = new THREE.DirectionalLight(0xdfe6f2, 0.42);
    fill.position.set(-2.6, 1.2, -1.8);
    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(-0.6, 0.8, -3);
    this.scene.add(key, fill, rim);
  }

  private buildFloor(): THREE.Group {
    const group = new THREE.Group();
    const grid = new THREE.GridHelper(14, 56, 0x8a8a95, 0x8a8a95);
    const material = grid.material as THREE.Material;
    material.transparent = true;
    material.opacity = 0.11;
    material.depthWrite = false;
    group.add(grid);
    return group;
  }

  /**
   * A soft contact shadow, drawn rather than computed. A real shadow map would
   * need the deformation replicated in the depth pass for one soft blob; this is
   * the same blob for none of the cost, and it scales with the load.
   */
  private buildShadow(): THREE.Mesh {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(0,0,0,0.42)');
      gradient.addColorStop(0.55, 'rgba(0,0,0,0.16)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }

  /** Swap in a different component. Called when the product program changes. */
  rebuild(options: ViewportOptions): void {
    this.options = options;
    this.disposeComponent();

    this.bundle = buildComponent(options.geometry, options.quality ?? 'high');
    this.uniforms.uFieldScale.value = options.fieldScale;

    const material = createComponentMaterial({
      geometry: options.geometry,
      color: options.color,
      roughness: options.roughness,
      uniforms: this.uniforms,
    });
    material.clippingPlanes = [];
    this.mesh = new THREE.Mesh(this.bundle.geometry, material);
    this.mesh.frustumCulled = false;

    const interiorMaterial = createComponentMaterial({
      geometry: options.geometry,
      color: options.color,
      roughness: options.roughness,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      interior: true,
    });
    interiorMaterial.clippingPlanes = [];
    this.interior = new THREE.Mesh(this.bundle.geometry, interiorMaterial);
    this.interior.frustumCulled = false;
    this.interior.visible = false;

    // The two wireframes are expensive to build — a WireframeGeometry walks
    // every triangle and de-duplicates its edges — and both are off by default.
    // They are created the first time they are actually switched on, so the
    // common case pays nothing for an overlay nobody opened.
    this.wire = new THREE.LineSegments();
    this.wire.visible = false;
    this.wire.frustumCulled = false;
    this.ghost = new THREE.LineSegments();
    this.ghost.visible = false;
    this.ghost.frustumCulled = false;
    this.wireBuilt = false;

    this.overlays = new Overlays(options.geometry);
    this.root.add(this.mesh, this.interior, this.wire, this.ghost, this.overlays.group);

    this.pickMesh = new THREE.Mesh(
      this.bundle.pick.geometry.clone(),
      new THREE.MeshBasicMaterial(),
    );
    this.pickDirty = true;

    // The program's own framing preference, applied on top of the exact fit as
    // extra breathing room rather than as a raw camera distance — so it means
    // the same thing at every camera angle and in every panel size.
    const box = boxOf(this.bundle.geometry);
    this.box = box.clone();
    this.framingSlack =
      Number.isFinite(options.distance) && options.distance > 0.2 && options.distance < 5
        ? options.distance
        : 1;
    const floorY = options.geometry === 'tread' ? -0.02 : box.min.y - 0.12;
    this.floor.position.y = floorY;
    this.floor.visible = options.showFloor !== false;
    this.shadow.position.y = floorY + 0.002;
    const footprint = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 1.9;
    this.shadow.scale.set(footprint, footprint, 1);

    const normal = SECTION_NORMAL[options.geometry];
    this.clipPlane.normal.set(normal[0], normal[1], normal[2]);
    this.clipPlane.constant = 0.002;

    // Zoom limits from the part's own size, so every component allows the same
    // amount of push-in and pull-out regardless of how big its units are.
    const span = this.box.getSize(new THREE.Vector3()).length();
    this.radius = span > 1e-4 ? span * 0.5 : 1;
    this.controls.minDistance = this.radius * 0.6;
    this.controls.maxDistance = this.radius * 14;
    this.controls.autoRotateSpeed = ((options.spin ?? 0) * 180) / Math.PI / 6;
    this.controls.autoRotate = (options.spin ?? 0) > 0;

    // Reframe on the preset the user is actually on, not unconditionally on
    // the default one — swapping the component should not quietly move them
    // off the section view they were reading.
    this.setCamera(this.preset, true);
    if (this.overlayState) this.setOverlays(this.overlayState);
    if (this.load) this.setLoad(this.load, this.amplitude, this.uniforms.uTolerance.value);
    // A paused viewport — scrolled out of view, or in a background tab — keeps
    // whatever was last composited. After a rebuild that is the PREVIOUS
    // component, which reads as the wrong part or none at all, so the next tick
    // is forced to draw regardless of whether rendering is otherwise running.
    this.drawn = false;
    this.dirty = true;
  }

  // ── Updates ──────────────────────────────────────────────────────────────

  setLoad(load: LoadState, amplitude: number, tolerance: number): void {
    // The two material scalars come from a behaviour mapping fed by estimates,
    // and an estimate over a formulation with no neighbours can be NaN. A NaN
    // amplitude multiplies every warp into something the GPU will not draw, so
    // both are pinned to their sane range before they reach a uniform.
    const safe = sanitiseParams({
      geometry: this.options.geometry,
      load,
      amplitude,
      tolerance,
      fieldScale: this.options.fieldScale,
    });
    // The copilot's recovery cards push a load every animation frame, and most
    // of those frames carry a value that has not actually moved. Re-running the
    // overlay rebuild for an identical load is pure waste, so an unchanged load
    // returns before any of it happens.
    if (
      this.load &&
      sameLoad(this.load, safe.load) &&
      this.amplitude === safe.amplitude &&
      this.uniforms.uTolerance.value === safe.tolerance
    ) {
      return;
    }

    this.load = safe.load;
    this.amplitude = safe.amplitude;
    applyLoad(this.uniforms, safe.load);
    this.uniforms.uAmplitude.value = safe.amplitude;
    this.uniforms.uTolerance.value = safe.tolerance;
    this.overlays.update(safe.load, safe.amplitude);
    this.pickDirty = true;
    this.dirty = true;
  }

  setMode(mode: VisualizationMode, fieldVisible: boolean): void {
    this.uniforms.uMode.value = fieldVisible ? MODE_INDEX[mode] : 0;
    this.dirty = true;
  }

  setOverlays(overlays: OverlayState): void {
    this.overlayState = overlays;
    if (overlays.mesh || overlays.ghost) this.ensureWireframes();
    this.wire.visible = overlays.mesh;
    this.ghost.visible = overlays.ghost;
    this.overlays.setVisible({ forces: overlays.forces, contact: overlays.contact });
    this.dirty = true;
  }

  /**
   * Populate the two wireframes, once, the first time either is switched on.
   * Both read the low-resolution pick mesh rather than the render mesh: a
   * wireframe of the full component is an unreadable grey wash, and the coarse
   * one is what actually shows how the surface is moving.
   */
  private ensureWireframes(): void {
    if (this.wireBuilt) return;
    this.wireBuilt = true;
    const edges = new THREE.WireframeGeometry(this.bundle.pick.geometry);
    this.wire.geometry = edges;
    this.wire.material = createWireMaterial(this.options.geometry, this.uniforms, {
      color: '#e8ecf4',
      opacity: 0.16,
      warped: true,
    });
    this.ghost.geometry = edges.clone();
    this.ghost.material = createWireMaterial(this.options.geometry, this.uniforms, {
      color: '#9aa6bb',
      opacity: 0.2,
      warped: false,
    });
  }

  setHighlightRegion(region: string | null): void {
    const index = region ? this.bundle.regions.indexOf(region) : -1;
    this.uniforms.uHighlightRegion.value = index;
    this.dirty = true;
  }

  setSpin(on: boolean): void {
    this.controls.autoRotate = on && (this.options.spin ?? 0) > 0;
    this.dirty = true;
  }

  setCamera(preset: CameraPreset, immediate = false): void {
    const framing = framingFor(this.options.geometry, preset);
    const dir = new THREE.Vector3(framing.dir[0], framing.dir[1], framing.dir[2]);
    // Fitted to the part's real bounding box in this view, at this viewport's
    // real aspect — so the same component fills a narrow rail and a wide stage
    // the same way, and a long part is not sized by a diagonal it never shows.
    const fit = fitGeometry(
      this.bundle.geometry,
      dir,
      this.camera.fov,
      this.camera.aspect,
      framing.margin * this.framingSlack,
    );
    const target = fit.position;
    this.orbitTarget.copy(fit.target);
    this.preset = preset;

    const section = preset === 'section';
    this.mesh.material = this.mesh.material as THREE.Material;
    const materials = [this.mesh.material, this.interior.material].flat() as THREE.Material[];
    for (const m of materials) m.clippingPlanes = section ? [this.clipPlane] : [];
    this.interior.visible = section;

    if (immediate) {
      this.camera.position.copy(target);
      this.controls.target.copy(this.orbitTarget);
      this.camera.lookAt(this.controls.target);
      this.controls.update();
    } else {
      this.tweenTo(target);
    }
    this.dirty = true;
    this.wake();
  }

  private tween: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromTarget: THREE.Vector3;
    t: number;
  } | null = null;

  private tweenTo(target: THREE.Vector3): void {
    this.tween = {
      from: this.camera.position.clone(),
      to: target,
      fromTarget: this.controls.target.clone(),
      t: 0,
    };
    this.wake();
  }

  /** Move the camera to look at a region of the part, keeping the same distance. */
  focusRegion(region: string): void {
    const centre = this.regionCentre(region);
    if (!centre) return;
    // Measured from the point the camera actually orbits, which is the box
    // centre rather than the origin — otherwise a part modelled off-centre is
    // pushed away from the camera every time a region is focused.
    const distance = this.camera.position.distanceTo(this.orbitTarget);
    const dir = centre.clone().sub(this.orbitTarget);
    if (dir.lengthSq() < 1e-6) dir.set(0.8, 0.5, 1);
    dir.normalize();
    // Pull the camera onto the region's side of the part, slightly raised.
    dir.y = Math.max(dir.y, 0.22);
    this.tweenTo(this.orbitTarget.clone().addScaledVector(dir.normalize(), distance));
    this.setHighlightRegion(region);
  }

  private regionCentre(region: string): THREE.Vector3 | null {
    const index = this.bundle.regions.indexOf(region);
    if (index < 0) return null;
    const positions = this.bundle.geometry.getAttribute('position');
    const regions = this.bundle.geometry.getAttribute('aRegion');
    const sum = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < regions.count; i++) {
      if (Math.abs(regions.getX(i) - index) > 0.25) continue;
      sum.x += positions.getX(i);
      sum.y += positions.getY(i);
      sum.z += positions.getZ(i);
      n++;
    }
    return n > 0 ? sum.divideScalar(n) : null;
  }

  onPick(handler: (region: string | null, point: THREE.Vector3 | null) => void): void {
    this.pickHandler = handler;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.pickHandler || event.button !== 0) return;
    // A click that turned into a drag is a camera move, not a pick.
    const startX = event.clientX;
    const startY = event.clientY;
    const onUp = (up: PointerEvent) => {
      this.canvas.removeEventListener('pointerup', onUp);
      if (Math.hypot(up.clientX - startX, up.clientY - startY) > 4) return;
      this.pick(up);
    };
    this.canvas.addEventListener('pointerup', onUp);
  };

  private pick(event: PointerEvent): void {
    if (!this.pickHandler) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.refreshPickMesh();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.pickMesh, false);
    const hit = hits[0];
    if (!hit || hit.face === undefined || hit.face === null) {
      this.pickHandler(null, null);
      return;
    }
    const regions = this.pickMesh.geometry.getAttribute('aRegion');
    const index = Math.round(regions.getX(hit.face.a));
    this.pickHandler(this.bundle.pick.regions[index] ?? null, hit.point.clone());
  }

  /**
   * The hit-test mesh follows the deformation on the CPU, using the same warp
   * the shader uses. Only refreshed when a pick is actually attempted, so it
   * costs nothing while a slider is moving.
   */
  private refreshPickMesh(): void {
    if (!this.pickDirty || !this.load) {
      this.pickMesh.matrix.copy(this.root.matrixWorld);
      this.pickMesh.matrixAutoUpdate = false;
      this.pickMesh.updateMatrixWorld();
      return;
    }
    const rest = this.bundle.pick.geometry.getAttribute('position');
    const live = this.pickMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const params: WarpParams = {
      geometry: this.options.geometry,
      load: this.load,
      amplitude: this.amplitude,
      tolerance: this.uniforms.uTolerance.value,
      fieldScale: this.options.fieldScale,
    };
    for (let i = 0; i < rest.count; i++) {
      const p = warp([rest.getX(i), rest.getY(i), rest.getZ(i)], params);
      live.setXYZ(i, p[0], p[1], p[2]);
    }
    live.needsUpdate = true;
    this.pickMesh.geometry.computeBoundingSphere();
    this.pickMesh.matrixAutoUpdate = false;
    this.pickMesh.matrix.copy(this.root.matrixWorld);
    this.pickMesh.updateMatrixWorld();
    this.pickDirty = false;
  }

  // ── Synchronised comparison ──────────────────────────────────────────────
  //
  // Two viewports side by side have to share a camera, or a difference in the
  // deformation cannot be told apart from a difference in the viewing angle.
  // The link is event-driven rather than polled: whichever camera the user
  // moves pushes to the other, once, when it changes. An `applying` flag stops
  // the two from echoing each other forever.

  private peer: ComponentViewport | null = null;
  private applying = false;
  private syncEnabled = true;

  /** Link two viewports so either one's camera drives the other. */
  linkTo(peer: ComponentViewport | null): void {
    this.peer = peer;
    if (peer) this.pushCamera();
  }

  setSyncEnabled(enabled: boolean): void {
    this.syncEnabled = enabled;
    if (enabled) this.pushCamera();
  }

  private pushCamera(): void {
    const peer = this.peer;
    if (!peer || this.applying || !this.syncEnabled) return;
    peer.applyCamera(this.camera.position, this.controls.target);
  }

  private applyCamera(position: THREE.Vector3, target: THREE.Vector3): void {
    this.applying = true;
    this.controls.autoRotate = false;
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.camera.lookAt(this.controls.target);
    this.dirty = true;
    this.applying = false;
  }

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return;
    const aspect = width / height;
    // Nothing to do for a resize that does not actually change anything. A
    // ResizeObserver fires on layout passes that left the box identical, and
    // reframing on those would fight a user who has moved the camera.
    if (
      Math.abs(aspect - this.camera.aspect) < 1e-4 &&
      this.viewWidth === width &&
      this.viewHeight === height
    ) {
      return;
    }
    const first = !this.framed;
    this.viewWidth = width;
    this.viewHeight = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // A component framed for a square viewport would be cut off in a wide one,
    // so the first real size reframes rather than only re-projecting.
    if (first) {
      this.framed = true;
      this.setCamera(this.preset, true);
    }
    this.dirty = true;
    this.wake();
  }

  /** Stop drawing when the viewport is off screen or the tab is hidden. */
  setRunning(running: boolean): void {
    this.running = running;
    if (running) {
      this.dirty = true;
      this.wake();
    }
  }

  /**
   * Restart the loop if it has parked itself. Every entry point that makes the
   * viewport dirty calls this, so a change that arrives while it is paused —
   * a new load, a camera move, a restored context — is still drawn.
   */
  private wake(): void {
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  // ── Context loss ─────────────────────────────────────────────────────────
  //
  // A browser takes a WebGL context away whenever it needs to: a backgrounded
  // tab, a GPU reset, or simply too many live contexts on one page. Three
  // handles the graphics side by itself — it calls preventDefault so a restore
  // is attempted, skips rendering while the context is gone, and re-initialises
  // its own state when it comes back.
  //
  // What it cannot do is know when this viewport next wants a frame, and that
  // is the whole failure. Rendering here is on demand: after a restore `dirty`
  // is false and `drawn` is true, so the loop returns early on every tick and
  // the component stays blank for good — the disappearance people actually see.
  // Marking the viewport un-drawn on restore forces exactly one frame, which is
  // all it takes for the part to come back.

  private contextLost = false;
  private lostTimer = 0;
  private goneHandler: (() => void) | null = null;

  /**
   * Called when the context has gone and stayed gone.
   *
   * The owner's only sane response is to throw this viewport away and build a
   * new one, so that is what it is told to do — a canvas whose context never
   * returns cannot be revived in place.
   */
  onContextGone(handler: () => void): void {
    this.goneHandler = handler;
  }

  /** True once the context is gone and the grace period has elapsed. */
  isDead(): boolean {
    return this.contextLost;
  }

  private readonly onContextLost = (): void => {
    this.contextLost = true;
    // Give the browser a moment to hand the context back on its own; only if it
    // does not is the heavier rebuild worth doing.
    window.clearTimeout(this.lostTimer);
    this.lostTimer = window.setTimeout(() => {
      if (this.contextLost) this.goneHandler?.();
    }, 700);
  };

  private readonly onContextRestored = (): void => {
    window.clearTimeout(this.lostTimer);
    this.contextLost = false;
    this.drawn = false;
    this.dirty = true;
  };

  private tick(): void {
    // A paused viewport stops scheduling altogether rather than waking every
    // frame to decide it has nothing to do. `setRunning` and `wake` restart it.
    if (!this.running && this.drawn) {
      this.frame = 0;
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
    if (this.contextLost) return;

    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + 0.07);
      const e = easeInOut(this.tween.t);
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, e);
      // Ease the orbit centre across too, or a part whose box centre is off the
      // origin swings through the frame on the way to its new view.
      this.controls.target.lerpVectors(this.tween.fromTarget, this.orbitTarget, e);
      this.camera.lookAt(this.controls.target);
      if (this.tween.t >= 1) this.tween = null;
      this.dirty = true;
    }

    const damped = this.controls.update();
    if (damped || this.controls.autoRotate) this.dirty = true;

    if (!this.dirty && this.drawn) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.drawn = true;
  }

  private disposeComponent(): void {
    for (const object of [this.mesh, this.interior, this.wire, this.ghost]) {
      if (object.parent) object.parent.remove(object);
      const material = object.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    }
    this.wire.geometry?.dispose();
    this.ghost.geometry?.dispose();
    this.pickMesh.geometry?.dispose();
    (this.pickMesh.material as THREE.Material | undefined)?.dispose();
    if (this.overlays) {
      this.root.remove(this.overlays.group);
      this.overlays.dispose();
    }
    if (this.bundle !== EMPTY_BUNDLE) {
      this.bundle?.geometry.dispose();
      this.bundle?.pick.geometry.dispose();
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.lostTimer);
    this.goneHandler = null;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.controls.dispose();
    this.disposeComponent();
    this.envTexture?.dispose();
    (this.shadow.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.shadow.geometry.dispose();
    this.floor.traverse((o) => {
      const line = o as THREE.LineSegments;
      line.geometry?.dispose();
      const m = line.material as THREE.Material | undefined;
      m?.dispose();
    });
    this.renderer.dispose();
    this.canvas.remove();
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const LOAD_AXES = [
  'compression',
  'shear',
  'pressure',
  'radial',
  'torsion',
  'bend',
  'stretch',
] as const;

const sameLoad = (a: LoadState, b: LoadState): boolean =>
  LOAD_AXES.every((axis) => a[axis] === b[axis]);

/**
 * Whether this browser can run the viewport at all.
 *
 * Answered once and remembered. The probe has to create a real context to get a
 * truthful answer, and a WebGL context is a scarce, hard-capped resource: a
 * browser allows only a handful at a time and silently kills the OLDEST live
 * one to stay under the cap. Probing repeatedly therefore does not merely waste
 * work — it evicts the very viewport it was asked about, which is what a black
 * canvas mid-drag actually is. So the probe runs a single time, and the context
 * it opened is handed straight back rather than left for the collector.
 */
let webglProbe: boolean | null = null;

export function webglAvailable(): boolean {
  if (webglProbe !== null) return webglProbe;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      // Release it now. Dropping the reference only frees the context whenever
      // the collector next runs, and until then it counts against the cap.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    webglProbe = Boolean(gl);
  } catch {
    webglProbe = false;
  }
  return webglProbe;
}
