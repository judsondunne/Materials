import { memo, useEffect, useRef, useState } from 'react';
import type { GeometryType, LoadState } from '../product/types';
import type { CameraPreset, OverlayState, VisualizationMode } from '../state/appState';
import type { Quality } from './geometry';
import { ComponentViewport, webglAvailable } from './scene';

/**
 * The React boundary around the viewport.
 *
 * Deliberately thin: React owns nothing inside the WebGL context. It creates the
 * viewport once, pushes state into it through effects, and tears it down on
 * unmount. Re-rendering this component does not touch the scene graph, which is
 * what allows the rest of the page to re-render while a slider is being dragged
 * without dropping a frame.
 */

export interface ViewportProps {
  geometry: GeometryType;
  color: string;
  roughness: number;
  distance: number;
  fieldScale: number;
  quality?: Quality;
  load: LoadState;
  amplitude: number;
  tolerance: number;
  mode: VisualizationMode;
  overlays: OverlayState;
  camera: CameraPreset;
  region?: string | null;
  /** Bumped to ask the camera to reframe onto `region`. */
  focusNonce?: number;
  /** Auto-rotation speed in radians per second. 0 disables it. */
  spin?: number;
  showFloor?: boolean;
  onPick?: (region: string | null) => void;
  /** Handed the live viewport so a comparison can synchronise two of them. */
  onReady?: (viewport: ComponentViewport | null) => void;
  className?: string;
  label?: string;
}

export const Viewport = memo(function Viewport(props: ViewportProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewport = useRef<ComponentViewport | null>(null);
  // A lazy initialiser, not a bare call. `useState(expr)` evaluates `expr` on
  // EVERY render and throws the result away after the first; since the probe
  // opens a WebGL context to answer, writing it that way opened one context per
  // render of this component — hundreds during a slider drag — and a browser
  // that is over its context cap reclaims them by killing the oldest live one,
  // which is this viewport. That is the component vanishing mid-drag.
  const [failed, setFailed] = useState(() => !webglAvailable());
  /**
   * Bumped to force a rebuild of the whole viewport.
   *
   * The browser is entitled to take the WebGL context away, and it does not
   * promise to give it back. When it does not, three's own restore path never
   * runs and the canvas stays black for good. Rather than leave a dead surface
   * on screen, the whole thing is torn down and built again on a fresh canvas —
   * which always works, because it is the same code that ran on first mount.
   */
  const [generation, setGeneration] = useState(0);
  const onPick = useRef(props.onPick);
  onPick.current = props.onPick;
  const onReady = useRef(props.onReady);
  onReady.current = props.onReady;

  const { geometry, color, roughness, distance, fieldScale, quality, spin, showFloor } = props;

  // One viewport per geometry. A different program rebuilds the component in
  // place rather than dropping and recreating the WebGL context.
  useEffect(() => {
    const container = host.current;
    if (!container || failed) return;
    let instance = viewport.current;
    if (generation > 0 && instance?.isDead()) {
      instance.dispose();
      instance = null;
      viewport.current = null;
    }
    try {
      if (!instance) {
        instance = new ComponentViewport(container, {
          geometry,
          color,
          roughness,
          distance,
          fieldScale,
          ...(quality ? { quality } : {}),
          ...(spin !== undefined ? { spin } : {}),
          ...(showFloor !== undefined ? { showFloor } : {}),
        });
        viewport.current = instance;
        instance.onPick((region) => onPick.current?.(region));
        onReady.current?.(instance);
      } else {
        instance.rebuild({
          geometry,
          color,
          roughness,
          distance,
          fieldScale,
          ...(quality ? { quality } : {}),
          ...(spin !== undefined ? { spin } : {}),
          ...(showFloor !== undefined ? { showFloor } : {}),
        });
      }
      const rect = container.getBoundingClientRect();
      instance.resize(rect.width, rect.height);
      // If the context goes and does not come back, rebuild rather than leave a
      // black rectangle where the component was.
      instance.onContextGone(() => setGeneration((g) => g + 1));
    } catch {
      // A context that cannot be created is a browser limitation, not an error
      // the user can act on. The rest of the workspace keeps working.
      setFailed(true);
    }
  }, [geometry, color, roughness, distance, fieldScale, quality, spin, showFloor, failed, generation]);

  useEffect(
    () => () => {
      onReady.current?.(null);
      viewport.current?.dispose();
      viewport.current = null;
    },
    [],
  );

  // Both observers re-bind on `generation`, because a rebuild after a lost
  // context replaces the instance. Reading `viewport.current` inside the
  // callback rather than closing over it means a viewport that is swapped out
  // between notifications can never be driven after it has been disposed.
  useEffect(() => {
    const container = host.current;
    if (!container || failed) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) viewport.current?.resize(box.width, box.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [failed, generation]);

  // Off screen or in a hidden tab, stop rendering entirely.
  useEffect(() => {
    const container = host.current;
    if (!container || failed) return;
    let onScreen = true;
    const sync = () => viewport.current?.setRunning(onScreen && !document.hidden);
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = Boolean(entries[0]?.isIntersecting);
        sync();
      },
      { threshold: 0.01 },
    );
    io.observe(container);
    document.addEventListener('visibilitychange', sync);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [failed, generation]);

  const { load, amplitude, tolerance } = props;
  useEffect(() => {
    viewport.current?.setLoad(load, amplitude, tolerance);
  }, [load, amplitude, tolerance]);

  useEffect(() => {
    viewport.current?.setMode(props.mode, props.overlays.field);
  }, [props.mode, props.overlays.field]);

  useEffect(() => {
    viewport.current?.setOverlays(props.overlays);
  }, [props.overlays]);

  useEffect(() => {
    viewport.current?.setCamera(props.camera);
  }, [props.camera]);

  useEffect(() => {
    viewport.current?.setHighlightRegion(props.region ?? null);
  }, [props.region]);

  // A bump on the nonce means somebody asked for the camera, not just the
  // highlight — the assistant reframing onto a region it is about to discuss.
  const nonce = props.focusNonce ?? 0;
  const regionRef = useRef(props.region);
  regionRef.current = props.region;
  useEffect(() => {
    if (nonce <= 0) return;
    const region = regionRef.current;
    if (region) viewport.current?.focusRegion(region);
  }, [nonce]);

  if (failed) {
    return (
      <div className={`vp vp--failed ${props.className ?? ''}`}>
        <p className="vp__failTitle">3D visualisation unavailable</p>
        <p className="vp__failBody">
          This browser could not create a WebGL context. Every formulation, requirement and estimate
          on this page still works — only the component view is missing.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`vp ${props.className ?? ''}`}
      ref={host}
      role="img"
      aria-label={props.label ?? 'Component simulation'}
    />
  );
});
