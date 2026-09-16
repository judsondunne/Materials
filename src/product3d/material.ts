import * as THREE from 'three';
import type { GeometryType, LoadState } from '../product/types';
import type { VisualizationMode } from '../state/appState';
import { RAMP_GLSL } from './colormap';
import { geometryDefine, sanitiseParams, WARP_GLSL } from './warp';

/**
 * The materials that deform.
 *
 * Deformation happens in the vertex shader, which is the only way a mesh of a
 * few thousand vertices can follow a slider continuously. Rather than write a
 * lighting model by hand, the demonstration warp is injected into three's own
 * physical material: the component therefore picks up soft environment
 * illumination, a real Fresnel response and correct shading under deformation,
 * because the normal is rebuilt from the warp itself.
 *
 * The normal is recovered by deforming two points a hair away along the stored
 * surface tangents and crossing the results. Since the warp is analytic and
 * defined on all of space, that gives the exact normal of the deformed surface
 * without touching the CPU.
 */

export interface ComponentUniforms {
  uCompression: { value: number };
  uShear: { value: number };
  uPressure: { value: number };
  uRadial: { value: number };
  uTorsion: { value: number };
  uBend: { value: number };
  uStretch: { value: number };
  uAmplitude: { value: number };
  uTolerance: { value: number };
  uFieldScale: { value: number };
  /** 0 material · 1 deformation · 2 stress · 3 strain. */
  uMode: { value: number };
  uFieldMix: { value: number };
  /** Divides the displacement before it is coloured, so the scale stays stable. */
  uDispScale: { value: number };
  uHighlightRegion: { value: number };
  [key: string]: { value: number };
}

export const MODE_INDEX: Record<VisualizationMode, number> = {
  material: 0,
  deformation: 1,
  stress: 2,
  strain: 3,
};

export function createUniforms(): ComponentUniforms {
  return {
    uCompression: { value: 0 },
    uShear: { value: 0 },
    uPressure: { value: 0 },
    uRadial: { value: 0 },
    uTorsion: { value: 0 },
    uBend: { value: 0 },
    uStretch: { value: 0 },
    uAmplitude: { value: 1 },
    uTolerance: { value: 1 },
    uFieldScale: { value: 1 },
    uMode: { value: 0 },
    uFieldMix: { value: 0.88 },
    uDispScale: { value: 0.28 },
    uHighlightRegion: { value: -1 },
  };
}

/**
 * Push a load into the uniforms.
 *
 * Every value is run through the same sanitiser the CPU warp uses, because a
 * single non-finite uniform is enough to make the GPU discard every triangle it
 * touches — which reads to the user as the component simply disappearing.
 */
export function applyLoad(uniforms: ComponentUniforms, load: LoadState): void {
  const safe = sanitiseParams({
    geometry: 'oring',
    load,
    amplitude: 1,
    tolerance: 1,
    fieldScale: 1,
  }).load;
  uniforms.uCompression.value = safe.compression;
  uniforms.uShear.value = safe.shear;
  uniforms.uPressure.value = safe.pressure;
  uniforms.uRadial.value = safe.radial;
  uniforms.uTorsion.value = safe.torsion;
  uniforms.uBend.value = safe.bend;
  uniforms.uStretch.value = safe.stretch;
}

const VERTEX_HEAD = /* glsl */ `
attribute vec3 aTan;
attribute vec3 aBitan;
attribute float aEdge;
attribute float aRegion;
varying float vField;
varying float vDisp;
varying float vStrain;
varying float vRegion;
uniform float uDispScale;
`;

const FRAGMENT_HEAD = /* glsl */ `
varying float vField;
varying float vDisp;
varying float vStrain;
varying float vRegion;
uniform float uMode;
uniform float uFieldMix;
uniform float uHighlightRegion;
`;

/** Rebuild the normal, and record the three scalars the fragment shader colours by. */
const VERTEX_BODY = /* glsl */ `
  const float EPS = 0.004;
  vec3 warped = safeWarpPoint(position);
  vec3 wt = safeWarpPoint(position + aTan * EPS);
  vec3 wb = safeWarpPoint(position + aBitan * EPS);
  vec3 dt = wt - warped;
  vec3 db = wb - warped;
  // Where the warp folds a surface flat the two tangents can become parallel and
  // the cross product vanishes. normalize(0) is NaN, which would black out the
  // fragment, so a degenerate frame falls back to the rest normal.
  vec3 faceNormal = cross(dt, db);
  vec3 objectNormal = length(faceNormal) > 1e-9 ? normalize(faceNormal) : normal;
  if (objectNormal.x != objectNormal.x) objectNormal = normal;
  if (dot(objectNormal, normal) < 0.0) objectNormal = -objectNormal;

  vField = fieldNormalised(position, aEdge);
  vDisp = clamp(length(warped - position) / max(uDispScale, 1e-4), 0.0, 1.0);
  // Local stretch: how much the two surface tangents changed length. A
  // deformation measure taken from the warp itself rather than a second model.
  float st = length(dt) / EPS;
  float sb = length(db) / EPS;
  vStrain = clamp((max(abs(st - 1.0), abs(sb - 1.0))) * 2.2, 0.0, 1.0);
  vRegion = aRegion;
`;

const FRAGMENT_BODY = /* glsl */ `
  float fieldValue = uMode < 1.5 ? vDisp : (uMode < 2.5 ? vField : vStrain);
  float amount = uMode < 0.5 ? 0.0 : uFieldMix;
  diffuseColor.rgb = mix(diffuseColor.rgb, rampColor(fieldValue), amount);
  if (uHighlightRegion > -0.5 && abs(vRegion - uHighlightRegion) < 0.25) {
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.38, 0.56, 0.95), 0.26);
  }
`;

interface ComponentMaterialOptions {
  geometry: GeometryType;
  color: string;
  roughness: number;
  uniforms: ComponentUniforms;
  side?: THREE.Side;
  /** The cutaway's inner fill is flatter and darker so the section reads. */
  interior?: boolean;
}

export function createComponentMaterial(opts: ComponentMaterialOptions): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(opts.color),
    roughness: opts.interior ? 0.95 : opts.roughness,
    metalness: 0,
    clearcoat: opts.interior ? 0 : 0.35,
    clearcoatRoughness: 0.5,
    sheen: opts.interior ? 0 : 0.25,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color('#8894a8'),
    envMapIntensity: opts.interior ? 0.35 : 1.05,
    side: opts.side ?? THREE.FrontSide,
    flatShading: false,
  });

  const define = geometryDefine(opts.geometry);

  material.onBeforeCompile = (shader) => {
    shader.defines = { ...(shader.defines ?? {}), [define]: '' };
    for (const [key, value] of Object.entries(opts.uniforms)) shader.uniforms[key] = value;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}\n${WARP_GLSL}`)
      .replace('#include <beginnormal_vertex>', VERTEX_BODY)
      .replace('#include <begin_vertex>', 'vec3 transformed = warped;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}\n${RAMP_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_BODY}`);
  };
  // Two materials with the same program cache key would share a compiled
  // program despite different defines, so the key carries the geometry.
  material.customProgramCacheKey = () => `component:${define}:${opts.interior ? 'in' : 'out'}`;

  return material;
}

/**
 * The deformed wireframe overlay and the undeformed ghost.
 *
 * Both are line materials; only the first one warps. The ghost is the rest
 * shape, which is what makes "how far did it actually move" readable at a
 * glance rather than something to be inferred from a number.
 */
export function createWireMaterial(
  geometry: GeometryType,
  uniforms: ComponentUniforms,
  opts: { color: string; opacity: number; warped: boolean },
): THREE.ShaderMaterial {
  const define = geometryDefine(geometry);
  return new THREE.ShaderMaterial({
    defines: { [define]: '' },
    uniforms: {
      ...uniforms,
      uColor: { value: new THREE.Color(opts.color) },
      uOpacity: { value: opts.opacity },
    } as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      ${WARP_GLSL}
      void main() {
        vec3 p = ${opts.warped ? 'safeWarpPoint(position)' : 'position'};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() { gl_FragColor = vec4(uColor, uOpacity); }
    `,
    transparent: true,
    depthWrite: false,
  });
}
