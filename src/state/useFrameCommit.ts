import { useCallback, useEffect, useRef } from 'react';

/**
 * One commit per frame, and never a lost final value.
 *
 * A range input fires `input` as fast as the pointer produces events, which on a
 * trackpad or a high-rate mouse is well above the display's refresh rate. Every
 * one of those was committing application state and re-rendering a workspace
 * that costs the better part of a frame to render, so a drag would saturate the
 * main thread for as long as it lasted. That is not merely a stutter: a page
 * that stops yielding loses its WebGL context, and the component viewport goes
 * black and stays black.
 *
 * So the value is coalesced to the frame. Intermediate values are dropped —
 * nobody can see a slider position that was never painted — and the last one is
 * always flushed, which is the only one that has to be correct. The input keeps
 * tracking the pointer at the pointer's own rate, because the browser moves the
 * thumb itself.
 */
export function useFrameCommit<T>(commit: (value: T) => void): (value: T) => void {
  const pending = useRef<{ value: T } | null>(null);
  const frame = useRef(0);
  const timer = useRef(0);
  const latest = useRef(commit);
  latest.current = commit;

  const flush = useRef(() => {
    cancelAnimationFrame(frame.current);
    window.clearTimeout(timer.current);
    frame.current = 0;
    timer.current = 0;
    const next = pending.current;
    pending.current = null;
    if (next) latest.current(next.value);
  });

  useEffect(
    () => () => {
      // A drag that ends by unmounting still has to land its last value.
      flush.current();
    },
    [],
  );

  return useCallback((value: T) => {
    pending.current = { value };
    if (frame.current || timer.current) return;
    frame.current = requestAnimationFrame(() => flush.current());
    // A background tab never runs an animation frame, so a value set there would
    // sit pending forever. The timer is the floor, not the normal path: whichever
    // fires first flushes, and flushing cancels the other.
    timer.current = window.setTimeout(() => flush.current(), 40);
  }, []);
}
