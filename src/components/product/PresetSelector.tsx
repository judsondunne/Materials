import { useEffect, useRef, useState } from 'react';
import { formatValue } from '../../domain/format';
import type { Dataset } from '../../domain/types';
import type { FormulationPreset } from '../../product/presets';
import { Icon } from '../Icon';
import { LineageBadge, SupportChip } from './Lineage';

/**
 * Choosing where the formulation comes from.
 *
 * Every entry is derived — the best match for the brief, the extremes of each
 * measured property, and the two candidates the bounded search returns — and
 * every entry says which kind of thing it is before it says anything else. The
 * distinction between a formulation that was tested and one a model proposes is
 * the most important thing on this control, so it is the first thing on it.
 */

export function PresetSelector({
  ds,
  presets,
  activeId,
  custom,
  onSelect,
}: {
  ds: Dataset;
  presets: readonly FormulationPreset[];
  activeId: string | null;
  /** True when the user has edited away from every preset. */
  custom: boolean;
  onSelect: (preset: FormulationPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const active = presets.find((p) => p.id === activeId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = custom ? 'Your edits' : (active?.name ?? 'Choose a starting point');

  return (
    <div className="psel" ref={host}>
      <button
        type="button"
        className={`psel__btn ${open ? 'is-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="psel__btnText">
          <span className="psel__btnLabel">{label}</span>
          <span className="psel__btnSub">
            {custom
              ? 'estimated from the nearest real experiments'
              : (active?.experimentId ?? (active ? 'model-generated candidate' : 'select'))}
          </span>
        </span>
        {/* A badge reading "Your edit" beside a label already reading "Your
            edits" is noise. Provenance is only badged when the name alone does
            not carry it. */}
        {!custom && active ? <LineageBadge kind={active.lineage} compact /> : null}
        <Icon name="chevronDown" size={12} />
      </button>

      {open && (
        <ul className="psel__menu" role="listbox">
          {presets.map((preset) => {
            const on = !custom && preset.id === activeId;
            return (
              <li key={preset.id}>
                <button
                  type="button"
                  className={`psel__item ${on ? 'is-on' : ''}`}
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onSelect(preset);
                    setOpen(false);
                  }}
                >
                  <span className={`psel__mark psel__mark--${preset.lineage}`} aria-hidden="true">
                    {preset.lineage === 'historical' ? '●' : '◇'}
                  </span>
                  <span className="psel__body">
                    <span className="psel__name">
                      {preset.name}
                      {preset.support && <SupportChip level={preset.support} />}
                    </span>
                    <span className="psel__detail">{preset.detail}</span>
                    <span className="psel__outs num">
                      {ds.outputs.slice(0, 5).map((o) => {
                        const meta = ds.fields.get(o);
                        const v = preset.outputs[o];
                        if (!meta || v === undefined || !Number.isFinite(v)) return null;
                        return (
                          <span key={o} className="psel__out">
                            <span className="psel__outName">{meta.short}</span>
                            {preset.lineage === 'estimated' && '~'}
                            {formatValue(v, meta.decimals)}
                          </span>
                        );
                      })}
                    </span>
                  </span>
                  {on && <Icon name="check" size={12} />}
                </button>
              </li>
            );
          })}
          {custom && (
            <li>
              <span className="psel__item is-on is-custom">
                <span className="psel__mark" aria-hidden="true">
                  ◆
                </span>
                <span className="psel__body">
                  <span className="psel__name">Your edits</span>
                  <span className="psel__detail">
                    The formulation currently in the editor. Pick any entry above to replace it.
                  </span>
                </span>
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
