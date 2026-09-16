import * as THREE from 'three';
import type { GeometryType, LoadState } from '../product/types';
import { DIMS } from './warp';

/**
 * Engineering overlays: the plates that do the squeezing, the force vectors, and
 * the contact marks.
 *
 * These are the things that make a deformation legible as an ENGINEERING event
 * rather than an animation. The plate is where the load comes from; the arrows
 * say which way and how hard; the contact mark says where the part is bearing.
 * All three are positioned from the same load state that drives the warp, so the
 * plate always sits exactly on the deformed surface rather than near it.
 */

const ARROW_COLOR = '#c2703a';
const PRESSURE_COLOR = '#3f7fa8';
const CONTACT_COLOR = '#d8b25a';

function arrowMesh(material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1, 10), material);
  shaft.position.y = 0.5;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.13, 14), material);
  head.position.y = 1.065;
  group.add(shaft, head);
  return group;
}

/** Point an arrow group from `from` toward `to`, scaled to that length. */
function aim(arrow: THREE.Group, from: THREE.Vector3, to: THREE.Vector3): void {
  const dir = to.clone().sub(from);
  const len = dir.length();
  arrow.position.copy(from);
  arrow.scale.set(1, Math.max(len, 1e-3), 1);
  if (len > 1e-6) {
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }
  arrow.visible = len > 0.02;
}

export class Overlays {
  readonly group = new THREE.Group();

  private readonly plates = new THREE.Group();
  private readonly arrows = new THREE.Group();
  private readonly contacts = new THREE.Group();

  private readonly arrowPool: THREE.Group[] = [];
  private readonly pressurePool: THREE.Group[] = [];

  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  private plateTop: THREE.Mesh | null = null;
  private plateBottom: THREE.Mesh | null = null;
  private road: THREE.Mesh | null = null;
  private contactRingTop: THREE.Mesh | null = null;
  private contactRingBottom: THREE.Mesh | null = null;
  private contactPatch: THREE.Mesh | null = null;

  constructor(private readonly geometry: GeometryType) {
    this.group.add(this.plates, this.arrows, this.contacts);
    this.build();
  }

  private track<T extends THREE.BufferGeometry | THREE.Material>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private build(): void {
    // The plates say where the load comes from, so they have to be visible —
    // and they must never hide the thing being loaded. Hence a low opacity and
    // no depth write: the component always reads through them.
    const plateMat = this.track(
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#8b95a3'),
        metalness: 0.6,
        roughness: 0.28,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const arrowMat = this.track(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(ARROW_COLOR), transparent: true, opacity: 0.92 }),
    );
    const pressureMat = this.track(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PRESSURE_COLOR), transparent: true, opacity: 0.9 }),
    );
    const contactMat = this.track(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(CONTACT_COLOR),
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );

    for (let i = 0; i < 8; i++) {
      const a = arrowMesh(arrowMat);
      a.visible = false;
      this.arrowPool.push(a);
      this.arrows.add(a);
    }
    for (let i = 0; i < 10; i++) {
      const a = arrowMesh(pressureMat);
      a.visible = false;
      this.pressurePool.push(a);
      this.arrows.add(a);
    }

    if (this.geometry === 'oring' || this.geometry === 'bushing') {
      const radius = this.geometry === 'oring' ? DIMS.oring.major * 1.32 : DIMS.bushing.outer * 1.22;
      const disc = this.track(new THREE.CylinderGeometry(radius, radius, 0.016, 72));
      this.plateTop = new THREE.Mesh(disc, plateMat);
      this.plateBottom = new THREE.Mesh(disc, plateMat);
      this.plates.add(this.plateTop, this.plateBottom);

      const ringRadius = this.geometry === 'oring' ? DIMS.oring.major : DIMS.bushing.outer * 0.72;
      const ring = this.track(new THREE.TorusGeometry(ringRadius, 0.016, 8, 96));
      this.contactRingTop = new THREE.Mesh(ring, contactMat);
      this.contactRingBottom = new THREE.Mesh(ring, contactMat);
      this.contactRingTop.rotation.x = Math.PI / 2;
      this.contactRingBottom.rotation.x = Math.PI / 2;
      this.contacts.add(this.contactRingTop, this.contactRingBottom);
    }

    if (this.geometry === 'tread') {
      const plane = this.track(new THREE.BoxGeometry(DIMS.tread.width * 1.7, 0.03, DIMS.tread.length * 1.5));
      this.road = new THREE.Mesh(plane, plateMat);
      this.road.position.y = -0.015;
      this.plates.add(this.road);

      const patch = this.track(new THREE.PlaneGeometry(1, 1));
      this.contactPatch = new THREE.Mesh(patch, contactMat);
      this.contactPatch.rotation.x = -Math.PI / 2;
      this.contactPatch.position.y = 0.004;
      this.contacts.add(this.contactPatch);
    }
  }

  setVisible(opts: { forces: boolean; contact: boolean }): void {
    this.arrows.visible = opts.forces;
    this.contacts.visible = opts.contact;
    // Plates belong with the force story: they are how the load is applied.
    this.plates.visible = opts.forces || opts.contact;
  }

  /** Reposition every overlay for a load state. Called on change, not per frame. */
  update(load: LoadState, amplitude: number): void {
    for (const a of this.arrowPool) a.visible = false;
    for (const a of this.pressurePool) a.visible = false;

    switch (this.geometry) {
      case 'oring':
        this.updateORing(load, amplitude);
        break;
      case 'bushing':
        this.updateBushing(load, amplitude);
        break;
      case 'hose':
        this.updateHose(load, amplitude);
        break;
      case 'tread':
        this.updateTread(load, amplitude);
        break;
    }
  }

  private updateORing(load: LoadState, amplitude: number): void {
    const { major: R, tube: r } = DIMS.oring;
    const c = Math.min(0.62, load.compression * amplitude);
    const h = r * (1 - c);
    const shear = load.shear * r * 1.15 * amplitude;
    const drift = -load.pressure * r * 0.45;

    if (this.plateTop && this.plateBottom) {
      const active = c > 1e-3;
      this.plateTop.visible = active;
      this.plateBottom.visible = active;
      this.plateTop.position.set(shear + drift * 0.4, h + 0.011, 0);
      this.plateBottom.position.set(-shear + drift * 0.4, -h - 0.011, 0);
    }
    if (this.contactRingTop && this.contactRingBottom) {
      const active = c > 1e-3;
      this.contactRingTop.visible = active;
      this.contactRingBottom.visible = active;
      this.contactRingTop.position.set(shear + drift, h - 0.004, 0);
      this.contactRingBottom.position.set(-shear + drift, -h + 0.004, 0);
      const squash = 1 + c * 0.55;
      this.contactRingTop.scale.set(1, 1, squash);
      this.contactRingBottom.scale.set(1, 1, squash);
    }

    // Face load: four arrows onto each plate, length reading the load.
    const reach = 0.16 + c * 0.9;
    let n = 0;
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const x = Math.cos(angle) * R * 0.78;
      const z = Math.sin(angle) * R * 0.78;
      if (c > 1e-3) {
        const top = this.arrowPool[n++];
        if (top) aim(top, new THREE.Vector3(x + shear, h + 0.03 + reach, z), new THREE.Vector3(x + shear, h + 0.05, z));
        const bottom = this.arrowPool[n++];
        if (bottom) {
          aim(
            bottom,
            new THREE.Vector3(x - shear, -h - 0.03 - reach, z),
            new THREE.Vector3(x - shear, -h - 0.05, z),
          );
        }
      }
    }

    // Misalignment: one arrow across the top face.
    if (Math.abs(load.shear) > 1e-3) {
      const a = this.arrowPool[n++];
      if (a) {
        const y = h + 0.14;
        aim(
          a,
          new THREE.Vector3(-R * 0.4 + shear, y, 0),
          new THREE.Vector3(-R * 0.4 + shear + Math.sign(load.shear) * (0.25 + Math.abs(load.shear) * 0.7), y, 0),
        );
      }
    }

    // Pressure: distributed arrows against the outboard face.
    if (load.pressure > 1e-3) {
      const len = 0.12 + load.pressure * 0.4;
      let i = 0;
      for (const angle of [-0.9, -0.45, 0, 0.45, 0.9]) {
        for (const yy of [-r * 0.45, r * 0.45]) {
          const arrow = this.pressurePool[i++];
          if (!arrow) continue;
          const px = Math.cos(angle) * (R + r);
          const pz = Math.sin(angle) * (R + r);
          const dir = new THREE.Vector3(-Math.cos(angle), 0, -Math.sin(angle));
          const from = new THREE.Vector3(px, yy, pz).addScaledVector(dir, -len);
          aim(arrow, from, new THREE.Vector3(px, yy, pz).addScaledVector(dir, -0.02));
        }
      }
    }
  }

  private updateBushing(load: LoadState, amplitude: number): void {
    const { outer: Ro, inner: Ri, height: H } = DIMS.bushing;
    const c = Math.min(0.55, load.compression * amplitude);
    const top = (H / 2) * (1 - c);

    if (this.plateTop && this.plateBottom) {
      const active = c > 1e-3;
      this.plateTop.visible = active;
      this.plateBottom.visible = active;
      this.plateTop.position.set(0, top + 0.012, 0);
      this.plateBottom.position.set(0, -top - 0.012, 0);
    }
    if (this.contactRingTop && this.contactRingBottom) {
      const active = c > 1e-3;
      this.contactRingTop.visible = active;
      this.contactRingBottom.visible = active;
      this.contactRingTop.position.set(0, top, 0);
      this.contactRingBottom.position.set(0, -top, 0);
      this.contactRingTop.scale.setScalar(1);
      this.contactRingBottom.scale.setScalar(1);
    }

    let n = 0;
    const reach = 0.16 + c * 0.8;
    if (c > 1e-3) {
      for (const angle of [0, Math.PI]) {
        const x = Math.cos(angle) * Ro * 0.55;
        const z = Math.sin(angle) * Ro * 0.55;
        const a = this.arrowPool[n++];
        if (a) aim(a, new THREE.Vector3(x, top + 0.04 + reach, z), new THREE.Vector3(x, top + 0.06, z));
        const b = this.arrowPool[n++];
        if (b) aim(b, new THREE.Vector3(x, -top - 0.04 - reach, z), new THREE.Vector3(x, -top - 0.06, z));
      }
    }
    if (load.radial > 1e-3) {
      const len = 0.18 + load.radial * 0.5;
      for (const y of [-H * 0.22, 0, H * 0.22]) {
        const a = this.arrowPool[n++];
        if (a) aim(a, new THREE.Vector3(Ri * 0.2 + len, y, 0), new THREE.Vector3(Ri * 0.2, y, 0));
      }
    }
    if (Math.abs(load.shear) > 1e-3) {
      const a = this.arrowPool[n++];
      if (a) {
        aim(
          a,
          new THREE.Vector3(-Ro * 0.5, H / 2 + 0.1, 0),
          new THREE.Vector3(-Ro * 0.5 + Math.sign(load.shear) * (0.25 + Math.abs(load.shear) * 0.6), H / 2 + 0.1, 0),
        );
      }
    }
    if (Math.abs(load.torsion) > 0.5) {
      // Torque reads as a pair of tangential arrows on the top face.
      const scale = 0.16 + (Math.abs(load.torsion) / 45) * 0.45;
      const dir = Math.sign(load.torsion);
      for (const angle of [0, Math.PI]) {
        const a = this.arrowPool[n++];
        if (!a) continue;
        const rad = Ro * 0.8;
        const from = new THREE.Vector3(Math.cos(angle) * rad, H / 2 + 0.09, Math.sin(angle) * rad);
        const tangent = new THREE.Vector3(-Math.sin(angle) * dir, 0, Math.cos(angle) * dir);
        aim(a, from, from.clone().addScaledVector(tangent, scale));
      }
    }
  }

  private updateHose(load: LoadState, _amplitude: number): void {
    const { outer: Ro, inner: Ri, length: L } = DIMS.hose;
    if (this.plateTop) this.plateTop.visible = false;
    if (this.plateBottom) this.plateBottom.visible = false;

    let n = 0;
    if (load.pressure > 1e-3) {
      const len = 0.1 + load.pressure * 0.3;
      let i = 0;
      for (const z of [-L * 0.3, 0, L * 0.3]) {
        for (const angle of [Math.PI / 2, -Math.PI / 2, 0]) {
          const arrow = this.pressurePool[i++];
          if (!arrow) continue;
          const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
          const from = new THREE.Vector3(dir.x * Ri * 0.2, dir.y * Ri * 0.2, z);
          aim(arrow, from, from.clone().addScaledVector(dir, Ri * 0.2 + len));
        }
      }
    }
    if (load.stretch > 1e-3) {
      const len = 0.2 + load.stretch * 0.8;
      const a = this.arrowPool[n++];
      if (a) aim(a, new THREE.Vector3(0, 0, L / 2 + 0.04), new THREE.Vector3(0, 0, L / 2 + 0.04 + len));
      const b = this.arrowPool[n++];
      if (b) aim(b, new THREE.Vector3(0, 0, -L / 2 - 0.04), new THREE.Vector3(0, 0, -L / 2 - 0.04 - len));
    }
    if (load.bend > 1e-3) {
      // A bending moment reads as opposed transverse arrows at the two ends.
      const len = 0.18 + load.bend * 0.5;
      const a = this.arrowPool[n++];
      if (a) aim(a, new THREE.Vector3(-Ro - 0.06, 0, L / 2), new THREE.Vector3(-Ro - 0.06 + len, 0, L / 2));
      const b = this.arrowPool[n++];
      if (b) aim(b, new THREE.Vector3(-Ro - 0.06, 0, -L / 2), new THREE.Vector3(-Ro - 0.06 + len, 0, -L / 2));
    }
  }

  private updateTread(load: LoadState, amplitude: number): void {
    const { width: W, height: H, length: L } = DIMS.tread;
    const c = Math.min(0.5, load.compression * amplitude);
    if (this.road) this.road.visible = true;

    if (this.contactPatch) {
      const active = c > 1e-3;
      this.contactPatch.visible = active;
      // Contact grows with load, which is the whole point of a contact patch.
      const lengthFrac = Math.min(1, 0.25 + c * 2.4);
      this.contactPatch.scale.set(W * 1.02, L * lengthFrac, 1);
    }

    let n = 0;
    if (c > 1e-3) {
      const reach = 0.2 + c * 0.9;
      const topY = H + 0.34;
      for (const x of [-W * 0.26, W * 0.26]) {
        const a = this.arrowPool[n++];
        if (a) aim(a, new THREE.Vector3(x, topY + reach, 0), new THREE.Vector3(x, topY, 0));
      }
    }
    if (Math.abs(load.shear) > 1e-3) {
      const len = 0.24 + Math.abs(load.shear) * 0.7;
      const dir = Math.sign(load.shear);
      for (const x of [-W * 0.26, W * 0.26]) {
        const a = this.arrowPool[n++];
        if (!a) continue;
        const from = new THREE.Vector3(x, 0.05, -dir * (L / 2 + 0.06));
        aim(a, from, from.clone().add(new THREE.Vector3(0, 0, dir * len)));
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }
}
