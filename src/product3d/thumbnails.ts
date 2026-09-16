import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GeometryType } from '../product/types';
import { buildComponent } from './geometry';
import { boxOf, fitGeometry } from './framing';

/**
 * Still renders of each component, for the product chooser.
 *
 * Four live viewports on one screen would mean four WebGL contexts to look at
 * four objects that are not moving. One renderer draws each component once, off
 * screen, and hands back an image — so the cards look like the thing they select
 * and cost nothing after the first frame.
 */

export interface ThumbnailRequest {
  geometry: GeometryType;
  color: string;
  roughness: number;
}

const cache = new Map<string, string>();
const key = (r: ThumbnailRequest) => `${r.geometry}:${r.color}:${r.roughness}`;

/**
 * The angle each component is shown from — chosen so the card reads as the part
 * it selects: the seal from slightly above so the bore is visible, the bushing
 * three-quarter on, the hose down its length rather than into its bore, the
 * tread across the blocks. Only the DIRECTION is specified; how far away the
 * camera goes is solved from the geometry, so the four cards are framed
 * identically however different the parts are.
 */
const VIEW: Record<GeometryType, [number, number, number]> = {
  oring: [0.5, 0.78, 0.95],
  bushing: [0.78, 0.52, 1],
  hose: [0.92, 0.46, 0.72],
  tread: [0.52, 0.8, 1],
};

/** One margin for all four cards, now that the fit itself is exact. */
const THUMB_MARGIN = 1.06;

export function renderThumbnails(
  requests: readonly ThumbnailRequest[],
  size = { width: 480, height: 320 },
): Map<GeometryType, string> {
  const out = new Map<GeometryType, string>();
  const pending = requests.filter((r) => !cache.has(key(r)));
  for (const r of requests) {
    const hit = cache.get(key(r));
    if (hit) out.set(r.geometry, hit);
  }
  if (pending.length === 0) return out;

  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size.width, size.height, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.035);
    pmrem.dispose();

    const scene = new THREE.Scene();
    scene.environment = env.texture;
    scene.environmentIntensity = 0.9;
    const key1 = new THREE.DirectionalLight(0xffffff, 1.3);
    key1.position.set(2.2, 3.4, 2.4);
    const fill = new THREE.DirectionalLight(0xdfe6f2, 0.4);
    fill.position.set(-2.4, 1, -1.6);
    scene.add(key1, fill);

    const camera = new THREE.PerspectiveCamera(34, size.width / size.height, 0.05, 60);

    for (const request of pending) {
      const bundle = buildComponent(request.geometry, 'medium');
      // A plain physical material: the thumbnail shows the part at rest, so
      // none of the deformation machinery is needed here.
      const material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(request.color),
        roughness: request.roughness,
        metalness: 0,
        clearcoat: 0.3,
        clearcoatRoughness: 0.5,
        envMapIntensity: 1.1,
      });
      const mesh = new THREE.Mesh(bundle.geometry, material);
      scene.add(mesh);

      const view = VIEW[request.geometry];
      const framing = fitGeometry(
        bundle.geometry,
        new THREE.Vector3(view[0], view[1], view[2]),
        camera.fov,
        camera.aspect,
        THUMB_MARGIN,
      );
      camera.position.copy(framing.position);
      camera.lookAt(framing.target);
      // The near/far planes have to contain a part that may sit well off the
      // origin, or a correctly framed component would be clipped away.
      const span = boxOf(bundle.geometry).getSize(new THREE.Vector3()).length();
      camera.near = Math.max(0.01, framing.position.distanceTo(framing.target) - span);
      camera.far = framing.position.distanceTo(framing.target) + span * 2;
      camera.updateProjectionMatrix();

      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      cache.set(key(request), url);
      out.set(request.geometry, url);

      scene.remove(mesh);
      material.dispose();
      bundle.geometry.dispose();
      bundle.pick.geometry.dispose();
    }

    env.texture.dispose();
  } catch {
    // No WebGL: the cards fall back to a drawn silhouette.
    return out;
  } finally {
    renderer?.dispose();
  }
  return out;
}
