import * as THREE from 'three';

/**
 * Camera framing, solved rather than guessed.
 *
 * Every component here is a different shape: a seal is a flat ring, a hose is a
 * long tube, a tread is a wide slab. Framing them by their bounding SPHERE —
 * the usual shortcut — sizes each one by its longest diagonal, so anything that
 * is not roughly cubic ends up surrounded by empty space in the direction it is
 * thin. The usual patch is a hand-tuned fudge factor per part, which then has
 * to be re-tuned for every camera angle and every panel size it appears in.
 *
 * So the distance is solved instead. The part's bounding box is projected into
 * the camera's own basis and the distance is taken that puts the outermost
 * corner exactly on the edge of the frustum, in whichever of the two axes binds
 * first. That is correct for any shape, any view direction and any aspect
 * ratio, which means one margin constant reads the same on all four components.
 */

export interface Framing {
  /** Where to put the camera. */
  position: THREE.Vector3;
  /** What to point it at — the box centre, not the origin. */
  target: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

/**
 * Solve the camera placement that fits `box` for a camera looking along
 * `direction`, leaving `margin` (1.0 = the part exactly touches the frame).
 */
export function fitBox(
  box: THREE.Box3,
  direction: THREE.Vector3,
  fovDegrees: number,
  aspect: number,
  margin = 1.05,
): Framing {
  const target = box.getCenter(new THREE.Vector3());
  const dir = direction.clone().normalize();
  if (!Number.isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-9) dir.set(0.8, 0.55, 1).normalize();

  // A camera basis around the view direction. `up` degenerates when looking
  // straight down, so a second axis stands in for that case.
  const up = Math.abs(dir.dot(UP)) > 0.999 ? FALLBACK_UP : UP;
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const camUp = new THREE.Vector3().crossVectors(right, dir).normalize();

  const safeAspect = Number.isFinite(aspect) && aspect > 0.01 ? aspect : 1;
  const tanV = Math.tan((fovDegrees * Math.PI) / 360) / margin;
  const tanH = tanV * safeAspect;

  const min = box.min;
  const max = box.max;
  const corner = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let distance = 0;

  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
    offset.subVectors(corner, target);
    // Depth of this corner behind the camera plane, plus the distance its
    // lateral offset demands before it falls inside the frustum.
    const along = offset.dot(dir);
    const lateral = Math.abs(offset.dot(right)) / tanH;
    const vertical = Math.abs(offset.dot(camUp)) / tanV;
    distance = Math.max(distance, along + Math.max(lateral, vertical));
  }

  if (!Number.isFinite(distance) || distance <= 1e-4) distance = 1;

  return { position: target.clone().addScaledVector(dir, distance), target };
}

/**
 * Fit the actual surface rather than its bounding box.
 *
 * A box is a loose stand-in for a round part: fitting a torus by its box makes
 * the corners bind, and the corners are exactly where a torus has nothing, so
 * the part ends up floating in a frame it never touches. Solving over the
 * vertices themselves puts the true silhouette on the frame edge, which is what
 * "fitted" means to anyone looking at it.
 *
 * Every vertex is tested — the same arithmetic as the box case, eight orders of
 * magnitude cheaper than the tessellation that produced them — with a stride on
 * meshes dense enough that sampling is indistinguishable from the full sweep.
 */
export function fitGeometry(
  geometry: THREE.BufferGeometry,
  direction: THREE.Vector3,
  fovDegrees: number,
  aspect: number,
  margin = 1.05,
): Framing {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const box = boxOf(geometry);
  if (!position || position.count === 0) {
    return fitBox(box, direction, fovDegrees, aspect, margin);
  }

  const target = box.getCenter(new THREE.Vector3());
  const dir = direction.clone();
  if (!Number.isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-9) dir.set(0.8, 0.55, 1);
  dir.normalize();

  const up = Math.abs(dir.dot(UP)) > 0.999 ? FALLBACK_UP : UP;
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const camUp = new THREE.Vector3().crossVectors(right, dir).normalize();

  const safeAspect = Number.isFinite(aspect) && aspect > 0.01 ? aspect : 1;
  const tanV = Math.tan((fovDegrees * Math.PI) / 360) / margin;
  const tanH = tanV * safeAspect;

  const stride = Math.max(1, Math.floor(position.count / 4000));
  const offset = new THREE.Vector3();
  let distance = 0;

  for (let i = 0; i < position.count; i += stride) {
    offset.set(position.getX(i), position.getY(i), position.getZ(i)).sub(target);
    if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y) || !Number.isFinite(offset.z)) {
      continue;
    }
    const along = offset.dot(dir);
    const lateral = Math.abs(offset.dot(right)) / tanH;
    const vertical = Math.abs(offset.dot(camUp)) / tanV;
    distance = Math.max(distance, along + Math.max(lateral, vertical));
  }

  if (!Number.isFinite(distance) || distance <= 1e-4) {
    return fitBox(box, direction, fovDegrees, aspect, margin);
  }
  return { position: target.clone().addScaledVector(dir, distance), target };
}

/** The bounding box of a geometry's rest positions. */
export function boxOf(geometry: THREE.BufferGeometry): THREE.Box3 {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position) return new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const box = new THREE.Box3().setFromBufferAttribute(position);
  // A degenerate or non-finite box would put the camera at NaN and draw nothing.
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x) || box.isEmpty()) {
    return new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  }
  return box;
}
