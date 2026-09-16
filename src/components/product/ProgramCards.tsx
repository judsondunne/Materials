import { useEffect, useMemo, useState } from 'react';
import type { GeometryType, ProductProgram } from '../../product/types';
import { renderThumbnails } from '../../product3d/thumbnails';
import { Icon } from '../Icon';

/**
 * "What are you developing?"
 *
 * Four cards, each showing the actual component the material is for, rendered
 * from the same procedural geometry the studio uses — so the card is a picture
 * of the thing it selects rather than an icon standing in for it. One renderer
 * draws all four once, off screen; if WebGL is unavailable the cards fall back
 * to a drawn silhouette and nothing else changes.
 */

export function ProgramChooser({
  programs,
  activeId,
  onSelect,
}: {
  programs: readonly ProductProgram[];
  activeId: string | null;
  onSelect: (program: ProductProgram) => void;
}) {
  const thumbs = useThumbnails(programs);

  return (
    <ul className="pgc">
      {programs.map((program) => {
        const spec = program.spec;
        const url = thumbs.get(spec.geometryType);
        const on = spec.id === activeId;
        return (
          <li key={spec.id}>
            <button
              type="button"
              className={`pgc__card ${on ? 'is-on' : ''}`}
              onClick={() => onSelect(program)}
              aria-pressed={on}
            >
              <span className="pgc__cat">{spec.category}</span>
              <span className="pgc__name">{spec.name}</span>
              <span className="pgc__art">
                {url ? (
                  <img src={url} alt="" width={480} height={320} loading="lazy" />
                ) : (
                  <Silhouette geometry={spec.geometryType} />
                )}
              </span>
              <span className="pgc__objective">{spec.objective}</span>
              <span className="pgc__meta">
                <span className="num">{program.requirements.length}</span> target properties
                <span className="pgc__dot" aria-hidden="true">
                  ·
                </span>
                <span className="num">{program.loadCases.length}</span> load cases
              </span>
              <span className="pgc__go" aria-hidden="true">
                <Icon name="arrow" size={13} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function useThumbnails(programs: readonly ProductProgram[]): Map<GeometryType, string> {
  const requests = useMemo(
    () =>
      programs.map((p) => ({
        geometry: p.spec.geometryType,
        color: p.spec.visual.color,
        roughness: p.spec.visual.roughness,
      })),
    [programs],
  );
  const [thumbs, setThumbs] = useState<Map<GeometryType, string>>(new Map());

  useEffect(() => {
    // Rendering four components costs a few milliseconds; it is deferred so it
    // cannot delay the first paint of the page.
    let alive = true;
    const handle = window.setTimeout(() => {
      const result = renderThumbnails(requests);
      if (alive) setThumbs(result);
    }, 32);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [requests]);

  return thumbs;
}

/** Drawn fallback: a recognisable section of each component, no WebGL needed. */
function Silhouette({ geometry }: { geometry: GeometryType }) {
  return (
    <svg className="sil" viewBox="0 0 120 80" aria-hidden="true">
      {geometry === 'oring' && (
        <>
          <ellipse cx="60" cy="42" rx="40" ry="16" className="sil__body" />
          <ellipse cx="60" cy="42" rx="20" ry="7" className="sil__hole" />
          <ellipse cx="60" cy="36" rx="40" ry="16" className="sil__top" />
          <ellipse cx="60" cy="36" rx="20" ry="7" className="sil__hole" />
        </>
      )}
      {geometry === 'bushing' && (
        <>
          <rect x="34" y="24" width="52" height="36" rx="3" className="sil__body" />
          <ellipse cx="60" cy="24" rx="26" ry="9" className="sil__top" />
          <ellipse cx="60" cy="24" rx="10" ry="3.6" className="sil__hole" />
          <ellipse cx="60" cy="60" rx="26" ry="9" className="sil__body" />
        </>
      )}
      {geometry === 'hose' && (
        <>
          <path d="M20 52 Q60 16 100 52 L100 62 Q60 28 20 62 Z" className="sil__body" />
          <ellipse cx="20" cy="57" rx="4" ry="5" className="sil__hole" />
        </>
      )}
      {geometry === 'tread' && (
        <>
          <path d="M16 56 Q60 34 104 56 L104 64 Q60 42 16 64 Z" className="sil__body" />
          {[28, 48, 68, 88].map((x, i) => (
            <rect key={x} x={x} y={38 + i * 0} width="14" height="14" rx="2" className="sil__top" transform={`translate(0 ${Math.abs(60 - x) * 0.12})`} />
          ))}
        </>
      )}
    </svg>
  );
}
