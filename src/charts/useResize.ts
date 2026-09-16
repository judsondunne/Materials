import { useEffect, useRef, useState } from 'react';

/** Reports null until the element has a non-zero width, so no NaN-width SVG is
 *  ever rendered on the first paint. */
export function useResize<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  { width: number; height: number } | null,
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width < 1) return;
      setSize((prev) =>
        prev && Math.abs(prev.width - box.width) < 0.5 && Math.abs(prev.height - box.height) < 0.5
          ? prev
          : { width: box.width, height: box.height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size];
}
