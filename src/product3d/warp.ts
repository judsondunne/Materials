import type { GeometryType, LoadState } from '../product/types';

/**
 * The demonstration engineering model.
 *
 * ─── WHAT THIS IS ────────────────────────────────────────────────────────────
 * A SPATIAL WARP and a SCALAR FIELD, defined analytically for each geometry.
 * The warp maps every point of space to a deformed point; the field returns an
 * illustrative intensity in 0–1. Both are pure functions of the rest position,
 * the load state and two material scalars, so the same inputs always produce the
 * same picture — nothing here is random, and no vertex is coloured arbitrarily.
 *
 * ─── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * NOT finite element analysis. Not a stress solution. Not a prediction. The
 * supplied dataset contains no geometry, no modulus, no Poisson's ratio, no
 * stress–strain curve and no failure data, so a real solver could not be
 * configured from it even in principle. These warps were chosen to put the
 * deformation and the intensity where a reader of an engineering drawing would
 * expect them — flattening at a contact face, bulging at a free surface,
 * extension on the outside of a bend — and to respond monotonically and
 * continuously to load. That is the whole claim.
 *
 * Every surface that shows the output of this file labels it "illustrative".
 *
 * ─── WHY IT IS WRITTEN TWICE ─────────────────────────────────────────────────
 * The TypeScript below is the reference implementation: it is what the tests
 * pin, and what the CPU uses to find the hotspot and the peak intensity. The
 * GLSL at the bottom is a line-for-line mirror that runs per-vertex on the GPU,
 * which is the only way a continuously deforming mesh holds 60fps. They live in
 * the same file, adjacent, so a change to one is made next to the other.
 */

export type Vec3 = [number, number, number];

/** Rest dimensions of each demonstration component, in scene units. */
export const DIMS = {
  oring: { major: 1.0, tube: 0.3 },
  bushing: { outer: 0.8, inner: 0.32, height: 1.1 },
  hose: { outer: 0.4, inner: 0.29, length: 2.4 },
  tread: { width: 1.5, height: 0.42, length: 1.9, crown: 2.4 },
} as const;

export interface WarpParams {
  geometry: GeometryType;
  load: LoadState;
  /** Deformation multiplier from the material behaviour mapping (elongation). */
  amplitude: number;
  /** Field divisor from the material behaviour mapping (tensile strength). */
  tolerance: number;
  /** Per-program field scale, so every geometry reads on one legend. */
  fieldScale: number;
}

export const defaultParams = (geometry: GeometryType, load: LoadState): WarpParams => ({
  geometry,
  load,
  amplitude: 1,
  tolerance: 1,
  fieldScale: 1,
});

// ── Helpers, mirrored in GLSL ──────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Smooth approximation to max(x, 0). Keeps the warp differentiable at contact. */
function softMax0(x: number, k: number): number {
  return 0.5 * (x + Math.sqrt(x * x + k * k));
}

const tanh = (x: number) => Math.tanh(x);

// ── The four warps ─────────────────────────────────────────────────────────

/**
 * Automotive seal — a torus squeezed between two flat faces.
 *
 * The cross-section is flattened toward the faces with a hyperbolic tangent,
 * which produces the characteristic flat-topped, barrel-sided section without a
 * hard crease, and bulges radially in compensation so the section keeps roughly
 * its area. Shear offsets the top face; pressure pushes the ring across its
 * groove and squashes the pressurised side.
 */
function warpORing(p: Vec3, P: WarpParams): Vec3 {
  const { major: R, tube: r } = DIMS.oring;
  const [x, y, z] = p;
  const rad = Math.hypot(x, z);
  const safe = rad > 1e-5 ? rad : 1e-5;
  const dx = x / safe;
  const dz = z / safe;

  const c = clamp(P.load.compression * P.amplitude, 0, 0.62);
  const u = rad - R;
  const v = y;

  // Flatten toward the faces at ±h. tanh is ~linear near the middle and
  // saturates at the face, so the contact reads flat and the normals stay smooth.
  const h = r * (1 - c);
  const vOut = c > 1e-4 ? h * tanh(v / Math.max(h, 1e-4)) : v;

  // Section bulges outward where it is not against a face.
  const heightFrac = clamp(v / r, -1, 1);
  const bulge = c * 0.9 * (1 - heightFrac * heightFrac);
  let uOut = u * (1 + bulge);

  // Pressure squashes the side it acts on (+X) and pushes the ring to −X.
  const q = P.load.pressure;
  uOut *= 1 - q * 0.22 * Math.max(0, dx);
  const pressureShift = -q * r * 0.45;

  // Shear slides the top face relative to the bottom.
  const shearShift = P.load.shear * v * 1.15 * P.amplitude;

  const radOut = R + uOut;
  return [dx * radOut + shearShift + pressureShift, vOut, dz * radOut];
}

function fieldORing(p: Vec3, _edge: number, P: WarpParams): number {
  const { major: R, tube: r } = DIMS.oring;
  const [x, y, z] = p;
  const rad = Math.hypot(x, z);
  const safe = rad > 1e-5 ? rad : 1e-5;
  const dx = x / safe;
  const u = (rad - R) / r;
  const v = clamp(y / r, -1, 1);
  const c = clamp(P.load.compression * P.amplitude, 0, 0.62);

  // Against the faces: intensity concentrates where the section is flattened.
  const contact = smoothstep(0.32, 1, Math.abs(v)) * c * 2.0;
  // At the free equator: the outer fibre is in extension as the section bulges.
  const bulge = (1 - v * v) * c * 1.85 * smoothstep(-0.35, 1, u);
  // Shear loads one flank preferentially.
  const s = P.load.shear;
  const shear = Math.abs(s) * (0.3 + 0.7 * Math.abs(v)) * (0.45 + 0.55 * dx * Math.sign(s || 1)) * 1.5;
  // Pressure bears on the face it acts against.
  const press = P.load.pressure * (0.35 + 0.65 * Math.max(0, dx)) * 0.85;

  return normalise(Math.max(contact, bulge) + 0.65 * shear + 0.6 * press, P);
}

/**
 * Vibration isolator — a bushing with a bore.
 *
 * Axial load shortens it and barrels the wall, weighted to the outer surface.
 * A radial load moves the bore sideways with the displacement decaying across
 * the wall to zero at the shell. Shear slides the top across the bottom, and
 * torsion twists the section progressively up the height.
 */
function warpBushing(p: Vec3, P: WarpParams): Vec3 {
  const { outer: Ro, inner: Ri, height: H } = DIMS.bushing;
  const [x, y, z] = p;
  const rad = Math.hypot(x, z);
  const safe = rad > 1e-5 ? rad : 1e-5;
  const wall = Math.max(Ro - Ri, 1e-4);
  const t = clamp01((rad - Ri) / wall);

  const c = clamp(P.load.compression * P.amplitude, 0, 0.55);
  const hFrac = clamp((2 * y) / H, -1, 1);
  const yOut = y * (1 - c);

  const barrel = c * 0.6 * (1 - hFrac * hFrac) * (0.35 + 0.65 * t);
  const radOut = rad * (1 + barrel);
  let px = (x / safe) * radOut;
  let pz = (z / safe) * radOut;

  // Radial: the bore travels, the shell does not.
  const bore = 1 - t;
  px += -P.load.radial * wall * bore * bore * 1.4 * P.amplitude;

  // Shear: linear in height, damped toward the outer shell.
  px += P.load.shear * y * (1 - 0.55 * t) * 1.25 * P.amplitude;

  // Torsion: rotate about the axis by an angle that grows with height.
  const twist = ((P.load.torsion * Math.PI) / 180) * (y / H + 0.5) * P.amplitude;
  if (Math.abs(twist) > 1e-6) {
    const ca = Math.cos(twist);
    const sa = Math.sin(twist);
    const rx = px * ca - pz * sa;
    const rz = px * sa + pz * ca;
    px = rx;
    pz = rz;
  }

  return [px, yOut, pz];
}

function fieldBushing(p: Vec3, _edge: number, P: WarpParams): number {
  const { outer: Ro, inner: Ri, height: H } = DIMS.bushing;
  const [x, y, z] = p;
  const rad = Math.hypot(x, z);
  const safe = rad > 1e-5 ? rad : 1e-5;
  const dx = x / safe;
  const wall = Math.max(Ro - Ri, 1e-4);
  const t = clamp01((rad - Ri) / wall);
  const hFrac = clamp((2 * y) / H, -1, 1);

  const c = clamp(P.load.compression * P.amplitude, 0, 0.55);
  // Axial load is carried through the wall and peaks at the bonded bore.
  const axial = c * (0.55 + 0.9 * (1 - t)) * (1 - 0.35 * hFrac * hFrac) * 1.85;
  // Radial load shears the wall hardest at the bore on the loaded flank.
  const radial = P.load.radial * (1 - t) * (0.45 + 0.75 * Math.max(0, -dx)) * 1.5;
  const shear = P.load.shear * (0.35 + 0.8 * Math.abs(hFrac)) * (1 - 0.4 * t) * 1.3;
  const torsion = (Math.abs(P.load.torsion) / 45) * (1 - 0.5 * t) * (0.4 + 0.6 * Math.abs(hFrac)) * 1.0;

  return normalise(Math.max(axial, radial) + 0.7 * shear + 0.7 * torsion, P);
}

/**
 * Flexible hose — a tube along Z.
 *
 * Pressure expands the bore more than the outside, which thins the wall. Stretch
 * extends it axially with an illustrative volume-preserving radial contraction.
 * Bending maps the axis onto a circular arc: material on the outside of the bend
 * travels further and is in extension, the inside is compressed, and the section
 * ovalises slightly in the bend plane.
 */
function warpHose(p: Vec3, P: WarpParams): Vec3 {
  const { outer: Ro, inner: Ri, length: L } = DIMS.hose;
  const [x, y, z] = p;
  const rad = Math.hypot(x, y);
  const safe = rad > 1e-5 ? rad : 1e-5;
  const wall = Math.max(Ro - Ri, 1e-4);
  const t = clamp01((rad - Ri) / wall);

  const q = P.load.pressure * P.amplitude;
  const e = P.load.stretch * P.amplitude;

  // Pressure: bore grows faster than the outside, so the wall thins.
  const riOut = Ri * (1 + q * 0.26);
  const roOut = Ro * (1 + q * 0.17);
  let radOut = riOut + t * Math.max(roOut - riOut, 1e-4);

  // Stretch: illustrative volume-preserving contraction, not a Poisson ratio.
  radOut *= 1 / Math.sqrt(1 + Math.max(e, 0));
  let zOut = z * (1 + e);

  // Ovalise in the bend plane before bending, so the section reads correctly.
  const b = P.load.bend * P.amplitude;
  const dirX = (x / safe) * radOut;
  const dirY = (y / safe) * radOut;
  let px = dirX * (1 - 0.14 * b);
  const py = dirY * (1 + 0.07 * b);

  // Bend: constant curvature about a centre at +X, so −X is the outer fibre.
  const totalAngle = b * 1.25;
  const k = totalAngle / Math.max(L, 1e-4);
  if (Math.abs(k) > 1e-5) {
    const R0 = 1 / k;
    const rho = R0 - px;
    const ang = zOut * k;
    px = R0 - rho * Math.cos(ang);
    zOut = rho * Math.sin(ang);
  }

  return [px, py, zOut];
}

function fieldHose(p: Vec3, _edge: number, P: WarpParams): number {
  const { outer: Ro, inner: Ri } = DIMS.hose;
  const [x, y] = p;
  const rad = Math.hypot(x, y);
  const safe = rad > 1e-5 ? rad : 1e-5;
  const wall = Math.max(Ro - Ri, 1e-4);
  const t = clamp01((rad - Ri) / wall);
  const dx = x / safe;

  // Hoop stress from internal pressure peaks at the bore.
  const press = P.load.pressure * (0.45 + 0.95 * (1 - t)) * 0.62;
  // Bending peaks at the extreme fibres, and the outer fibre (−X) is stretched.
  const bendFibre = Math.abs(dx) * (rad / Math.max(Ro, 1e-4));
  const bend = P.load.bend * (0.25 + 1.15 * bendFibre) * (0.7 + 0.5 * Math.max(0, -dx)) * 0.55;
  const stretch = P.load.stretch * (0.7 + 0.6 * (1 - t)) * 1.6;

  return normalise(Math.max(press, bend) + 0.55 * Math.min(press, bend) + 0.8 * stretch, P);
}

/**
 * Tire tread — a crowned block section pressed onto a flat road.
 *
 * The section is translated down onto the road plane and every point that would
 * pass through it is smoothly held at the surface, which is what forms a contact
 * patch. The displaced material spreads sideways and along the rolling
 * direction. Shear leans the blocks over in proportion to their height above the
 * road, so the leading edge of each block lifts exactly as it does in reality.
 */
function warpTread(p: Vec3, P: WarpParams): Vec3 {
  const { height: H } = DIMS.tread;
  const [x, y, z] = p;

  const c = clamp(P.load.compression * P.amplitude, 0, 0.5);
  const drop = c * H * 1.6;

  // The contact is rounded over a width proportional to the squeeze, so at rest
  // the tread sits exactly on the road rather than floating a hair above it.
  const yt = y - drop;
  const yOut = softMax0(yt, drop * 0.35);
  // How much of this point's travel was absorbed by the road.
  const squash = clamp01((yOut - yt) / Math.max(H, 1e-4));

  const spread = squash * 0.4;
  const xOut = x * (1 + spread * 0.55);
  let zOut = z * (1 + spread);

  // Blocks lean: the further above the road, the further the block has moved.
  zOut += P.load.shear * yOut * 1.5 * P.amplitude;

  return [xOut, yOut, zOut];
}

function fieldTread(p: Vec3, edge: number, P: WarpParams): number {
  const { height: H, length: Lz } = DIMS.tread;
  const [y, z] = [p[1], p[2]];

  const c = clamp(P.load.compression * P.amplitude, 0, 0.5);
  const drop = c * H * 1.6;
  const yt = y - drop;
  const squash = clamp01(-yt / Math.max(H, 1e-4));

  // Contact loading, concentrated at the block edges where the rubber is free
  // to move and therefore strains most.
  const contact = squash * (0.55 + 0.95 * edge) * 2.1;
  // Shear leans the blocks; the root of each block carries it.
  const rootFrac = 1 - clamp01(y / Math.max(H, 1e-4));
  const centreFrac = 1 - clamp01((2 * Math.abs(z)) / Math.max(Lz, 1e-4));
  const shear = P.load.shear * (0.3 + 0.8 * rootFrac) * (0.4 + 0.6 * centreFrac) * (0.5 + 0.7 * edge) * 0.95;

  return normalise(Math.max(contact, 0) + 0.75 * shear, P);
}

/** Divide by the material's illustrative tolerance, scale, and clip to 0–1. */
function normalise(raw: number, P: WarpParams): number {
  const t = P.tolerance > 1e-4 ? P.tolerance : 1;
  return clamp01((raw * P.fieldScale) / t);
}

// ── Public entry points ────────────────────────────────────────────────────

/**
 * Every load number reaching a warp is finite and inside its own range.
 *
 * The sliders clamp, but the load also arrives from a restored URL, from a
 * running animation and from the assistant's tool calls, and a single NaN in a
 * uniform is enough to delete the component from the screen. Sanitising once, at
 * the boundary, means none of those paths has to be trusted.
 */
export function sanitiseParams(params: WarpParams): WarpParams {
  const finite = (v: number, fallback: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
  const load = params.load;
  return {
    geometry: params.geometry,
    amplitude: finite(params.amplitude, 1, 0.05, 4),
    tolerance: finite(params.tolerance, 1, 0.05, 8),
    fieldScale: finite(params.fieldScale, 1, 0.01, 20),
    load: {
      compression: finite(load.compression, 0, 0, 1),
      shear: finite(load.shear, 0, -2, 2),
      pressure: finite(load.pressure, 0, 0, 4),
      radial: finite(load.radial, 0, -2, 2),
      torsion: finite(load.torsion, 0, -180, 180),
      bend: finite(load.bend, 0, -2, 2),
      stretch: finite(load.stretch, 0, -0.9, 4),
    },
  };
}

/** The same fallback the shader applies: a point that is not finite does not move. */
function safe(p: Vec3, q: Vec3): Vec3 {
  return q.every((v) => Number.isFinite(v) && Math.abs(v) < 1e4) ? q : p;
}

export function warp(p: Vec3, params: WarpParams): Vec3 {
  const P = sanitiseParams(params);
  switch (P.geometry) {
    case 'oring':
      return safe(p, warpORing(p, P));
    case 'bushing':
      return safe(p, warpBushing(p, P));
    case 'hose':
      return safe(p, warpHose(p, P));
    case 'tread':
      return safe(p, warpTread(p, P));
  }
}

export function fieldIntensity(p: Vec3, edge: number, params: WarpParams): number {
  const P = sanitiseParams(params);
  const e = Number.isFinite(edge) ? edge : 0;
  const value = (() => {
    switch (P.geometry) {
      case 'oring':
        return fieldORing(p, e, P);
      case 'bushing':
        return fieldBushing(p, e, P);
      case 'hose':
        return fieldHose(p, e, P);
      case 'tread':
        return fieldTread(p, e, P);
    }
  })();
  return Number.isFinite(value) ? value : 0;
}

/** Displacement magnitude at a point, in scene units. */
export function displacement(p: Vec3, params: WarpParams): number {
  const q = warp(p, params);
  return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
}

export interface FieldSummary {
  /** Largest illustrative intensity anywhere on the sampled surface. */
  peak: number;
  /** Mean intensity, as a rough read on how much of the part is loaded. */
  mean: number;
  /** Largest displacement magnitude, in scene units. */
  maxDisplacement: number;
  /** Where the peak was found, in rest coordinates. */
  hotspot: Vec3 | null;
}

/**
 * Sample the field over the component's own surface so the UI can report a peak,
 * a severity band and a hotspot without reading pixels back off the GPU.
 *
 * The sample set is the geometry's parametric surface at a coarse resolution —
 * the same surface the mesh is built from, so the peak reported is a peak that
 * is actually on screen.
 */
export function summariseField(
  samples: readonly { p: Vec3; edge: number }[],
  params: WarpParams,
): FieldSummary {
  let peak = 0;
  let sum = 0;
  let maxDisp = 0;
  let hotspot: Vec3 | null = null;
  for (const s of samples) {
    const i = fieldIntensity(s.p, s.edge, params);
    sum += i;
    if (i > peak) {
      peak = i;
      hotspot = s.p;
    }
    const d = displacement(s.p, params);
    if (d > maxDisp) maxDisp = d;
  }
  return {
    peak,
    mean: samples.length > 0 ? sum / samples.length : 0,
    maxDisplacement: maxDisp,
    hotspot,
  };
}

// ── GLSL mirror ────────────────────────────────────────────────────────────
//
// A line-for-line translation of the four warps and four fields above. Kept in
// this file, immediately below its reference implementation, so the two are
// edited together. Which pair is compiled in is decided by a #define that the
// material sets from the program's geometry type.

export const WARP_GLSL = /* glsl */ `
uniform float uCompression;
uniform float uShear;
uniform float uPressure;
uniform float uRadial;
uniform float uTorsion;
uniform float uBend;
uniform float uStretch;
uniform float uAmplitude;
uniform float uTolerance;
uniform float uFieldScale;

float softMax0(float x, float k) { return 0.5 * (x + sqrt(x * x + k * k)); }
float sgn(float x) { return x < 0.0 ? -1.0 : 1.0; }
// GLSL ES 1.00 has no tanh. Same function, written out.
float tanhx(float x) {
  float e = exp(-2.0 * abs(x));
  float t = (1.0 - e) / (1.0 + e);
  return x < 0.0 ? -t : t;
}

#if defined(GEOM_ORING)
  const float R_MAJOR = ${DIMS.oring.major.toFixed(4)};
  const float R_TUBE  = ${DIMS.oring.tube.toFixed(4)};

  vec3 warpPoint(vec3 p) {
    float rad = length(p.xz);
    float safe = max(rad, 1e-5);
    float dx = p.x / safe;
    float dz = p.z / safe;

    float c = clamp(uCompression * uAmplitude, 0.0, 0.62);
    float u = rad - R_MAJOR;
    float v = p.y;

    float h = R_TUBE * (1.0 - c);
    float vOut = c > 1e-4 ? h * tanhx(v / max(h, 1e-4)) : v;

    float hf = clamp(v / R_TUBE, -1.0, 1.0);
    float bulge = c * 0.9 * (1.0 - hf * hf);
    float uOut = u * (1.0 + bulge);

    uOut *= 1.0 - uPressure * 0.22 * max(0.0, dx);
    float pressureShift = -uPressure * R_TUBE * 0.45;
    float shearShift = uShear * v * 1.15 * uAmplitude;

    float radOut = R_MAJOR + uOut;
    return vec3(dx * radOut + shearShift + pressureShift, vOut, dz * radOut);
  }

  float fieldPoint(vec3 p, float edge) {
    float rad = length(p.xz);
    float safe = max(rad, 1e-5);
    float dx = p.x / safe;
    float u = (rad - R_MAJOR) / R_TUBE;
    float v = clamp(p.y / R_TUBE, -1.0, 1.0);
    float c = clamp(uCompression * uAmplitude, 0.0, 0.62);

    float contact = smoothstep(0.32, 1.0, abs(v)) * c * 2.0;
    float bulge = (1.0 - v * v) * c * 1.85 * smoothstep(-0.35, 1.0, u);
    float shear = abs(uShear) * (0.3 + 0.7 * abs(v)) * (0.45 + 0.55 * dx * sgn(uShear)) * 1.5;
    float press = uPressure * (0.35 + 0.65 * max(0.0, dx)) * 0.85;
    return max(contact, bulge) + 0.65 * shear + 0.6 * press;
  }
#endif

#if defined(GEOM_BUSHING)
  const float B_OUTER  = ${DIMS.bushing.outer.toFixed(4)};
  const float B_INNER  = ${DIMS.bushing.inner.toFixed(4)};
  const float B_HEIGHT = ${DIMS.bushing.height.toFixed(4)};

  vec3 warpPoint(vec3 p) {
    float rad = length(p.xz);
    float safe = max(rad, 1e-5);
    float wall = max(B_OUTER - B_INNER, 1e-4);
    float t = clamp((rad - B_INNER) / wall, 0.0, 1.0);

    float c = clamp(uCompression * uAmplitude, 0.0, 0.55);
    float hf = clamp(2.0 * p.y / B_HEIGHT, -1.0, 1.0);
    float yOut = p.y * (1.0 - c);

    float barrel = c * 0.6 * (1.0 - hf * hf) * (0.35 + 0.65 * t);
    float radOut = rad * (1.0 + barrel);
    float px = (p.x / safe) * radOut;
    float pz = (p.z / safe) * radOut;

    float bore = 1.0 - t;
    px += -uRadial * wall * bore * bore * 1.4 * uAmplitude;
    px += uShear * p.y * (1.0 - 0.55 * t) * 1.25 * uAmplitude;

    float twist = radians(uTorsion) * (p.y / B_HEIGHT + 0.5) * uAmplitude;
    float ca = cos(twist);
    float sa = sin(twist);
    return vec3(px * ca - pz * sa, yOut, px * sa + pz * ca);
  }

  float fieldPoint(vec3 p, float edge) {
    float rad = length(p.xz);
    float safe = max(rad, 1e-5);
    float dx = p.x / safe;
    float wall = max(B_OUTER - B_INNER, 1e-4);
    float t = clamp((rad - B_INNER) / wall, 0.0, 1.0);
    float hf = clamp(2.0 * p.y / B_HEIGHT, -1.0, 1.0);

    float c = clamp(uCompression * uAmplitude, 0.0, 0.55);
    float axial = c * (0.55 + 0.9 * (1.0 - t)) * (1.0 - 0.35 * hf * hf) * 1.85;
    float radial = uRadial * (1.0 - t) * (0.45 + 0.75 * max(0.0, -dx)) * 1.5;
    float shear = uShear * (0.35 + 0.8 * abs(hf)) * (1.0 - 0.4 * t) * 1.3;
    float torsion = (abs(uTorsion) / 45.0) * (1.0 - 0.5 * t) * (0.4 + 0.6 * abs(hf)) * 1.0;
    return max(axial, radial) + 0.7 * shear + 0.7 * torsion;
  }
#endif

#if defined(GEOM_HOSE)
  const float H_OUTER  = ${DIMS.hose.outer.toFixed(4)};
  const float H_INNER  = ${DIMS.hose.inner.toFixed(4)};
  const float H_LENGTH = ${DIMS.hose.length.toFixed(4)};

  vec3 warpPoint(vec3 p) {
    float rad = length(p.xy);
    float safe = max(rad, 1e-5);
    float wall = max(H_OUTER - H_INNER, 1e-4);
    float t = clamp((rad - H_INNER) / wall, 0.0, 1.0);

    float q = uPressure * uAmplitude;
    float e = uStretch * uAmplitude;

    float riOut = H_INNER * (1.0 + q * 0.26);
    float roOut = H_OUTER * (1.0 + q * 0.17);
    float radOut = riOut + t * max(roOut - riOut, 1e-4);
    radOut *= 1.0 / sqrt(1.0 + max(e, 0.0));
    float zOut = p.z * (1.0 + e);

    float b = uBend * uAmplitude;
    float px = (p.x / safe) * radOut * (1.0 - 0.14 * b);
    float py = (p.y / safe) * radOut * (1.0 + 0.07 * b);

    float k = (b * 1.25) / max(H_LENGTH, 1e-4);
    if (abs(k) > 1e-5) {
      float R0 = 1.0 / k;
      float rho = R0 - px;
      float ang = zOut * k;
      px = R0 - rho * cos(ang);
      zOut = rho * sin(ang);
    }
    return vec3(px, py, zOut);
  }

  float fieldPoint(vec3 p, float edge) {
    float rad = length(p.xy);
    float safe = max(rad, 1e-5);
    float wall = max(H_OUTER - H_INNER, 1e-4);
    float t = clamp((rad - H_INNER) / wall, 0.0, 1.0);
    float dx = p.x / safe;

    float press = uPressure * (0.45 + 0.95 * (1.0 - t)) * 0.62;
    float bendFibre = abs(dx) * (rad / max(H_OUTER, 1e-4));
    float bend = uBend * (0.25 + 1.15 * bendFibre) * (0.7 + 0.5 * max(0.0, -dx)) * 0.55;
    float stretch = uStretch * (0.7 + 0.6 * (1.0 - t)) * 1.6;
    return max(press, bend) + 0.55 * min(press, bend) + 0.8 * stretch;
  }
#endif

#if defined(GEOM_TREAD)
  const float T_HEIGHT = ${DIMS.tread.height.toFixed(4)};
  const float T_LENGTH = ${DIMS.tread.length.toFixed(4)};

  vec3 warpPoint(vec3 p) {
    float c = clamp(uCompression * uAmplitude, 0.0, 0.5);
    float drop = c * T_HEIGHT * 1.6;

    float yt = p.y - drop;
    float yOut = softMax0(yt, drop * 0.35);
    float squash = clamp((yOut - yt) / max(T_HEIGHT, 1e-4), 0.0, 1.0);

    float spread = squash * 0.4;
    float xOut = p.x * (1.0 + spread * 0.55);
    float zOut = p.z * (1.0 + spread) + uShear * yOut * 1.5 * uAmplitude;
    return vec3(xOut, yOut, zOut);
  }

  float fieldPoint(vec3 p, float edge) {
    float c = clamp(uCompression * uAmplitude, 0.0, 0.5);
    float drop = c * T_HEIGHT * 1.6;
    float yt = p.y - drop;
    float squash = clamp(-yt / max(T_HEIGHT, 1e-4), 0.0, 1.0);

    float contact = squash * (0.55 + 0.95 * edge) * 2.1;
    float rootFrac = 1.0 - clamp(p.y / max(T_HEIGHT, 1e-4), 0.0, 1.0);
    float centreFrac = 1.0 - clamp(2.0 * abs(p.z) / max(T_LENGTH, 1e-4), 0.0, 1.0);
    float shear = uShear * (0.3 + 0.8 * rootFrac) * (0.4 + 0.6 * centreFrac) * (0.5 + 0.7 * edge) * 0.95;
    return max(contact, 0.0) + 0.75 * shear;
  }
#endif

float fieldNormalised(vec3 p, float edge) {
  float tol = uTolerance > 1e-4 ? uTolerance : 1.0;
  float raw = fieldPoint(p, edge) * uFieldScale / tol;
  // A field that is not a number colours nothing rather than colouring garbage.
  return raw == raw ? clamp(raw, 0.0, 1.0) : 0.0;
}

/**
 * The warp, made incapable of removing the component from the screen.
 *
 * A vertex whose position is NaN or infinite is discarded by the GPU along with
 * every triangle that touches it, so one bad number anywhere in the parameter
 * space would silently delete part of the part — or all of it. Every route into
 * the warp is therefore through here: if it does not produce a finite point
 * inside a sane bound, the vertex falls back to its rest position, and the
 * component stays on screen showing its undeformed shape instead of vanishing.
 *
 * GLSL ES 1.00 has no isnan/isinf, but a self-inequality is true only for NaN,
 * and a magnitude test catches the infinities.
 */
vec3 safeWarpPoint(vec3 p) {
  vec3 q = warpPoint(p);
  bvec3 bad = bvec3(q.x != q.x, q.y != q.y, q.z != q.z);
  if (any(bad) || abs(q.x) > 1e4 || abs(q.y) > 1e4 || abs(q.z) > 1e4) return p;
  return q;
}
`;

/** The #define the material needs for a geometry. */
export const geometryDefine = (geometry: GeometryType): string =>
  ({ oring: 'GEOM_ORING', bushing: 'GEOM_BUSHING', hose: 'GEOM_HOSE', tread: 'GEOM_TREAD' })[
    geometry
  ];
