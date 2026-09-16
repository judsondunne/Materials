import { useCallback, useRef } from 'react';

/**
 * A two-handle interval over a continuous domain.
 *
 * Built from two stacked native range inputs rather than pointer maths, so it
 * keeps keyboard support, focus rings and screen-reader announcements for free.
 * The lower handle sits above the upper one when they meet, which is what stops
 * the pair from locking together at the ends.
 */
export function RangeSlider({
  min,
  max,
  step,
  value,
  onChange,
  onCommit,
  label,
  format,
}: {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  onCommit?: () => void;
  label: string;
  format: (v: number) => string;
}) {
  const [lo, hi] = value;
  const span = max - min || 1;
  const pctLo = ((lo - min) / span) * 100;
  const pctHi = ((hi - min) / span) * 100;
  const atEnd = useRef(false);
  atEnd.current = pctLo > 60;

  const setLo = useCallback(
    (v: number) => onChange([Math.min(v, hi), hi]),
    [hi, onChange],
  );
  const setHi = useCallback(
    (v: number) => onChange([lo, Math.max(v, lo)]),
    [lo, onChange],
  );

  return (
    <div className="rs">
      <div className="rs__track">
        <span className="rs__fill" style={{ left: `${pctLo}%`, right: `${100 - pctHi}%` }} />
        <input
          className="rs__input rs__input--lo"
          type="range"
          min={min}
          max={max}
          step={step}
          value={lo}
          aria-label={`${label} lower bound`}
          onChange={(e) => setLo(Number(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          style={{ zIndex: atEnd.current ? 4 : 3 }}
        />
        <input
          className="rs__input rs__input--hi"
          type="range"
          min={min}
          max={max}
          step={step}
          value={hi}
          aria-label={`${label} upper bound`}
          onChange={(e) => setHi(Number(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
        />
      </div>
      <div className="rs__vals num">
        <span>{format(lo)}</span>
        <span className="rs__to">to</span>
        <span>{format(hi)}</span>
      </div>
    </div>
  );
}
