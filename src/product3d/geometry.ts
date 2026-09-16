import * as THREE from 'three';
import type { GeometryType } from '../product/types';
import { DIMS, type Vec3 } from './warp';

/**
 * Procedural component geometry.
 *
 * Every component is built here from its own parameters — there are no imported
 * assets — so each one is a clean analytic surface that the deformation warp can
 * be applied to, and each one can be rebuilt at a different resolution for
 * picking without a second source of truth.
 *
 * Each vertex carries four things beyond its position:
 *
 *   normal            the rest normal, used to orient the deformed normal.
 *   aTan, aBitan      two unit surface tangents with cross(aTan, aBitan) = normal.
 *                     The vertex shader deforms three points and rebuilds the
 *                     normal from them, which is what keeps lighting correct
 *                     under a large deformation without any CPU work.
 *   aEdge             proximity to a free edge, 0–1. Only the tread uses it, to
 *                     concentrate the illustrative field at block edges.
 *   aRegion           which named region of the part this vertex belongs to, so
 *                     a click can be answered with "the top contact face".
 */

export interface PatchSpec {
  /** Surface point for parameters in [0,1]². Must be defined slightly outside. */
  fn: (u: number, v: number) => Vec3;
  nu: number;
  nv: number;
  closedU?: boolean;
  closedV?: boolean;
  /** True when the natural cross(∂u, ∂v) points into the solid. */
  flip?: boolean;
  /** Free-edge proximity, 0–1. */
  edge?: (u: number, v: number) => number;
  region: string;
}

export interface BuiltGeometry {
  geometry: THREE.BufferGeometry;
  /** Rest positions and edge weights, for the CPU field summary. */
  samples: { p: Vec3; edge: number }[];
  /** Region name per region index, in the order the attribute refers to. */
  regions: string[];
}

const FD = 1e-3;

function buildFromPatches(specs: readonly PatchSpec[]): BuiltGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const tans: number[] = [];
  const bitans: number[] = [];
  const edges: number[] = [];
  const regionAttr: number[] = [];
  const indices: number[] = [];
  const samples: { p: Vec3; edge: number }[] = [];
  const regions: string[] = [];

  for (const spec of specs) {
    const regionIndex = regions.indexOf(spec.region) >= 0 ? regions.indexOf(spec.region) : regions.push(spec.region) - 1;
    const base = positions.length / 3;
    const { nu, nv, fn, flip = false } = spec;
    const stepsU = spec.closedU ? nu : nu - 1;
    const stepsV = spec.closedV ? nv : nv - 1;

    for (let i = 0; i < nu; i++) {
      const u = i / Math.max(stepsU, 1);
      for (let j = 0; j < nv; j++) {
        const v = j / Math.max(stepsV, 1);
        const p = fn(u, v);
        // Central differences give the two surface tangents for any fn, which
        // means a new component only has to supply its surface, not its algebra.
        const du = sub(fn(u + FD, v), fn(u - FD, v));
        const dv = sub(fn(u, v + FD), fn(u, v - FD));
        let t = normalize(du);
        let b = normalize(dv);
        if (flip) {
          const swap = t;
          t = b;
          b = swap;
        }
        const n = normalize(cross(t, b));

        positions.push(p[0], p[1], p[2]);
        normals.push(n[0], n[1], n[2]);
        tans.push(t[0], t[1], t[2]);
        bitans.push(b[0], b[1], b[2]);
        const e = spec.edge ? clamp01(spec.edge(u, v)) : 0;
        edges.push(e);
        regionAttr.push(regionIndex);
        samples.push({ p, edge: e });
      }
    }

    const rows = spec.closedU ? nu : nu - 1;
    const cols = spec.closedV ? nv : nv - 1;
    for (let i = 0; i < rows; i++) {
      const i2 = (i + 1) % nu;
      for (let j = 0; j < cols; j++) {
        const j2 = (j + 1) % nv;
        const a = base + i * nv + j;
        const bb = base + i * nv + j2;
        const c = base + i2 * nv + j;
        const d = base + i2 * nv + j2;
        // Winding follows the tangent pair, which the flip has already swapped.
        if (flip) {
          indices.push(a, c, bb, bb, c, d);
        } else {
          indices.push(a, bb, c, bb, d, c);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aTan', new THREE.Float32BufferAttribute(tans, 3));
  geometry.setAttribute('aBitan', new THREE.Float32BufferAttribute(bitans, 3));
  geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
  geometry.setAttribute('aRegion', new THREE.Float32BufferAttribute(regionAttr, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return { geometry, samples, regions };
}

// ── Profile revolution ─────────────────────────────────────────────────────
//
// Three of the four components are solids of revolution, so they share one
// generator: a closed 2D profile in the (radius, axis) plane, swept around the
// axis. Traversed counter-clockwise, the outward normal falls out of the
// tangent pair with no special cases.

type Profile = (s: number) => [number, number];

interface RevolveOptions {
  profile: Profile;
  nProfile: number;
  nTheta: number;
  /** 'y' leaves the axis vertical; 'z' rotates the finished part onto Z. */
  axis: 'y' | 'z';
  region: (s: number) => string;
  /** Distinct region names in the order `region` can return them. */
  regionNames: string[];
}

function revolve(opts: RevolveOptions): BuiltGeometry {
  const { profile, axis } = opts;
  // One patch per region so a click resolves to a named part of the surface,
  // and so the region attribute is constant across each patch.
  const specs: PatchSpec[] = [];
  const bands = bandsOf(opts.regionNames.length, opts);

  for (const band of bands) {
    specs.push({
      region: band.region,
      nu: Math.max(2, Math.round(opts.nProfile * (band.to - band.from)) + 1),
      nv: opts.nTheta,
      closedV: true,
      fn: (u, v) => {
        const s = band.from + u * (band.to - band.from);
        const [r, y] = profile(s);
        const theta = v * Math.PI * 2;
        const p: Vec3 = [r * Math.cos(theta), y, r * Math.sin(theta)];
        return axis === 'z' ? [p[0], -p[2], p[1]] : p;
      },
    });
  }
  return buildFromPatches(specs);
}

/**
 * Split the profile parameter into contiguous bands of one region each, by
 * sampling `region(s)` finely and cutting where the answer changes.
 */
function bandsOf(
  _count: number,
  opts: RevolveOptions,
): { from: number; to: number; region: string }[] {
  const probes = 400;
  const out: { from: number; to: number; region: string }[] = [];
  let start = 0;
  let current = opts.region(0);
  for (let i = 1; i <= probes; i++) {
    const s = i / probes;
    const region = i === probes ? current : opts.region(s);
    if (region !== current) {
      out.push({ from: start, to: s, region: current });
      start = s;
      current = region;
    }
  }
  out.push({ from: start, to: 1, region: current });
  return out.filter((b) => b.to - b.from > 1e-6);
}

/** A rounded-corner rectangle in the (radius, axis) plane, traversed CCW. */
function roundedProfile(
  rInner: number,
  rOuter: number,
  halfHeight: number,
  fillet: number,
): { at: Profile; sideOf: (s: number) => 'bottom' | 'outer' | 'top' | 'inner' } {
  const f = Math.min(fillet, (rOuter - rInner) / 3, halfHeight / 3);
  // Four straight runs and four quarter arcs, parameterised by arc length.
  const straightR = rOuter - rInner - 2 * f;
  const straightY = 2 * halfHeight - 2 * f;
  const arc = (Math.PI / 2) * f;
  const segs: { len: number; kind: 'bottom' | 'outer' | 'top' | 'inner' | 'arc'; at: (t: number) => [number, number]; side: 'bottom' | 'outer' | 'top' | 'inner' }[] = [
    {
      len: straightR,
      kind: 'bottom',
      side: 'bottom',
      at: (t) => [rInner + f + t * straightR, -halfHeight],
    },
    {
      len: arc,
      kind: 'arc',
      side: 'outer',
      at: (t) => {
        const a = (-Math.PI / 2) * (1 - t);
        return [rOuter - f + f * Math.cos(a), -halfHeight + f + f * Math.sin(a)];
      },
    },
    { len: straightY, kind: 'outer', side: 'outer', at: (t) => [rOuter, -halfHeight + f + t * straightY] },
    {
      len: arc,
      kind: 'arc',
      side: 'top',
      at: (t) => {
        const a = (Math.PI / 2) * t;
        return [rOuter - f + f * Math.cos(a), halfHeight - f + f * Math.sin(a)];
      },
    },
    { len: straightR, kind: 'top', side: 'top', at: (t) => [rOuter - f - t * straightR, halfHeight] },
    {
      len: arc,
      kind: 'arc',
      side: 'inner',
      at: (t) => {
        const a = Math.PI / 2 + (Math.PI / 2) * t;
        return [rInner + f + f * Math.cos(a), halfHeight - f + f * Math.sin(a)];
      },
    },
    { len: straightY, kind: 'inner', side: 'inner', at: (t) => [rInner, halfHeight - f - t * straightY] },
    {
      len: arc,
      kind: 'arc',
      side: 'bottom',
      at: (t) => {
        const a = Math.PI + (Math.PI / 2) * t;
        return [rInner + f + f * Math.cos(a), -halfHeight + f + f * Math.sin(a)];
      },
    },
  ];
  const total = segs.reduce((s, x) => s + x.len, 0);

  const locate = (s: number) => {
    let d = ((s % 1) + 1) % 1;
    d *= total;
    for (const seg of segs) {
      if (d <= seg.len || seg === segs[segs.length - 1]) {
        return { seg, t: seg.len > 0 ? Math.min(1, d / seg.len) : 0 };
      }
      d -= seg.len;
    }
    return { seg: segs[0]!, t: 0 };
  };

  return {
    at: (s) => {
      const { seg, t } = locate(s);
      return seg.at(t);
    },
    sideOf: (s) => locate(s).seg.side,
  };
}

// ── The four components ────────────────────────────────────────────────────

function buildORing(nTheta: number, nProfile: number): BuiltGeometry {
  const { major: R, tube: r } = DIMS.oring;
  return revolve({
    // The cross-section is a circle, traversed counter-clockwise from the
    // outer equator so s maps directly onto the section angle.
    profile: (s) => {
      const a = s * Math.PI * 2;
      return [R + r * Math.cos(a), r * Math.sin(a)];
    },
    nProfile,
    nTheta,
    axis: 'y',
    regionNames: ['outer-equator', 'contact-top', 'inner-bore', 'contact-bottom'],
    region: (s) => {
      const a = ((s % 1) + 1) % 1;
      if (a < 0.125 || a >= 0.875) return 'outer-equator';
      if (a < 0.375) return 'contact-top';
      if (a < 0.625) return 'inner-bore';
      return 'contact-bottom';
    },
  });
}

function buildBushing(nTheta: number, nProfile: number): BuiltGeometry {
  const { outer: Ro, inner: Ri, height: H } = DIMS.bushing;
  const prof = roundedProfile(Ri, Ro, H / 2, 0.06);
  return revolve({
    profile: prof.at,
    nProfile,
    nTheta,
    axis: 'y',
    regionNames: ['bottom-face', 'outer-wall', 'top-face', 'bore'],
    region: (s) => {
      const side = prof.sideOf(s);
      return side === 'inner' ? 'bore' : side === 'outer' ? 'outer-wall' : `${side}-face`;
    },
  });
}

function buildHose(nTheta: number, nProfile: number): BuiltGeometry {
  const { outer: Ro, inner: Ri, length: L } = DIMS.hose;
  const prof = roundedProfile(Ri, Ro, L / 2, 0.02);
  return revolve({
    profile: prof.at,
    nProfile,
    nTheta,
    axis: 'z',
    regionNames: ['end-face', 'outer-wall', 'inner-wall'],
    region: (s) => {
      const side = prof.sideOf(s);
      return side === 'inner' ? 'inner-wall' : side === 'outer' ? 'outer-wall' : 'end-face';
    },
  });
}

/**
 * The tread section: blocks on a crowned base.
 *
 * A representative section rather than a whole tire — a photoreal tire would be
 * a worse object to look at and a much worse object to deform legibly. The base
 * follows a circular crown along the rolling direction, so the section reads as
 * part of a wheel, and the road plane touches it at the centre.
 */
function buildTread(detail: number): BuiltGeometry {
  const { width: W, height: H, length: L, crown: Rc } = DIMS.tread;
  const crown = (z: number) => Rc - Math.sqrt(Math.max(Rc * Rc - z * z, 0));

  const blocksZ = 4;
  const grooveZ = 0.085;
  const colsX = 2;
  const grooveX = 0.1;

  const pitchZ = L / blocksZ;
  const blockZ = pitchZ - grooveZ;
  const pitchX = W / colsX;
  const blockX = pitchX - grooveX;

  const specs: PatchSpec[] = [];
  const n = Math.max(2, Math.round(detail));

  for (let bz = 0; bz < blocksZ; bz++) {
    const cz = -L / 2 + pitchZ * (bz + 0.5);
    for (let bx = 0; bx < colsX; bx++) {
      const cx = -W / 2 + pitchX * (bx + 0.5);

      // Local coordinates: lx, lz in [-0.5, 0.5] across the block.
      const at = (lx: number, lz: number, ly: number): Vec3 => {
        const z = cz + lz * blockZ;
        const x = cx + lx * blockX;
        return [x, crown(z) + ly * H, z];
      };
      // Edge proximity: 1 at a groove wall, falling off across the block face.
      const edgeAt = (lx: number, lz: number) => {
        const dx = (0.5 - Math.abs(lx)) * blockX;
        const dz = (0.5 - Math.abs(lz)) * blockZ;
        const d = Math.min(dx, dz);
        return 1 - smoothstep(0, 0.14, d);
      };

      // Road-facing face (the contact face is at the bottom, ly = 0).
      specs.push({
        region: 'contact-face',
        nu: n,
        nv: n,
        flip: true,
        fn: (u, v) => at(u - 0.5, v - 0.5, 0),
        edge: (u, v) => edgeAt(u - 0.5, v - 0.5),
      });
      // Carcass side.
      specs.push({
        region: 'block-top',
        nu: n,
        nv: n,
        fn: (u, v) => at(u - 0.5, v - 0.5, 1),
        edge: () => 0,
      });
      // Four groove walls.
      const walls: { region: string; fn: (u: number, v: number) => Vec3; flip?: boolean }[] = [
        { region: 'groove-wall', fn: (u, v) => at(0.5, u - 0.5, v), flip: true },
        { region: 'groove-wall', fn: (u, v) => at(-0.5, u - 0.5, v) },
        { region: 'block-edge', fn: (u, v) => at(u - 0.5, 0.5, v) },
        { region: 'block-edge', fn: (u, v) => at(u - 0.5, -0.5, v), flip: true },
      ];
      for (const w of walls) {
        specs.push({
          region: w.region,
          nu: n,
          nv: Math.max(2, Math.round(n / 2)),
          ...(w.flip ? { flip: true } : {}),
          fn: w.fn,
          // A groove wall is a free surface: its lower edge is where the field
          // concentrates, so proximity is measured to the contact face.
          edge: (_u, v) => 1 - smoothstep(0, 0.6, v),
        });
      }
    }
  }
  return buildFromPatches(specs);
}

export interface GeometryBundle extends BuiltGeometry {
  /** A quarter-resolution copy used for hit testing and for CPU field sampling. */
  pick: BuiltGeometry;
}

/** Resolution tiers, so a hero viewport and a card thumbnail share one generator. */
export type Quality = 'high' | 'medium' | 'low';

const TIERS: Record<Quality, number> = { high: 1, medium: 0.6, low: 0.35 };

export function buildComponent(type: GeometryType, quality: Quality = 'high'): GeometryBundle {
  const q = TIERS[quality];
  const render = (() => {
    switch (type) {
      case 'oring':
        return buildORing(Math.round(168 * q), Math.round(72 * q));
      case 'bushing':
        return buildBushing(Math.round(132 * q), Math.round(120 * q));
      case 'hose':
        return buildHose(Math.round(108 * q), Math.round(140 * q));
      case 'tread':
        return buildTread(Math.round(11 * q) + 2);
    }
  })();
  const pick = (() => {
    switch (type) {
      case 'oring':
        return buildORing(48, 24);
      case 'bushing':
        return buildBushing(40, 40);
      case 'hose':
        return buildHose(32, 44);
      case 'tread':
        return buildTread(4);
    }
  })();
  return { ...render, pick };
}

export { REGIONS, REGIONS_BY_GEOMETRY, regionInfo, type RegionInfo } from './regions';

// ── Small vector helpers ───────────────────────────────────────────────────

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

// ── Cached surface samples ─────────────────────────────────────────────────
//
// The CPU needs the component's surface to report a peak field intensity and a
// hotspot. It needs it at low resolution, and it needs it without a WebGL
// context, so the low tier is generated once per geometry and the buffers are
// released immediately — only the plain sample array is kept.

const sampleCache = new Map<GeometryType, { p: Vec3; edge: number }[]>();

export function surfaceSamples(type: GeometryType): { p: Vec3; edge: number }[] {
  const hit = sampleCache.get(type);
  if (hit) return hit;
  const bundle = buildComponent(type, 'low');
  const samples = bundle.samples;
  bundle.geometry.dispose();
  bundle.pick.geometry.dispose();
  sampleCache.set(type, samples);
  return samples;
}
