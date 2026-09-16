import { useEffect, useRef, useState } from 'react';
import type { ProductProgram } from '../../product/types';
import { Icon } from '../Icon';

/**
 * Changing what we are developing.
 *
 * Switching here changes the requirements, the best historical match, the preset
 * set, the geometry, the load cases and what the copilot knows — which is the
 * point: the application is a platform for developing a material for a part, not
 * a demo about one O-ring.
 */
export function ProductSwitcher({
  programs,
  activeId,
  onSelect,
  onClear,
}: {
  programs: readonly ProductProgram[];
  activeId: string;
  onSelect: (program: ProductProgram) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const active = programs.find((p) => p.spec.id === activeId) ?? programs[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!active) return null;

  return (
    <div className="psw" ref={host}>
      <button
        type="button"
        className={`psw__btn ${open ? 'is-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="psw__text">
          <span className="psw__label">{active.spec.name}</span>
          <span className="psw__cat">{active.spec.category}</span>
        </span>
        <span className="psw__chev" aria-hidden="true">
          <Icon name="chevronDown" size={12} />
        </span>
      </button>
      {open && (
        <ul className="psw__menu" role="listbox">
          {programs.map((program) => (
            <li key={program.spec.id}>
              <button
                type="button"
                role="option"
                aria-selected={program.spec.id === activeId}
                className={`psw__item ${program.spec.id === activeId ? 'is-on' : ''}`}
                onClick={() => {
                  onSelect(program);
                  setOpen(false);
                }}
              >
                <span className="psw__itemName">{program.spec.name}</span>
                <span className="psw__itemCat">{program.spec.category}</span>
                {program.spec.id === activeId && <Icon name="check" size={12} />}
              </button>
            </li>
          ))}
          {onClear && (
            <li className="psw__foot">
              <button
                type="button"
                className="psw__item psw__item--clear"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
              >
                Choose a different kind of product…
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
