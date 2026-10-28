/**
 * Modal sheet for the shell screens (account, leaderboards, guild, and the wave C
 * economy screens). Only the top sheet of a stack is `active`: it alone takes
 * Escape and focus. Sheets below it stay mounted but are `hidden`, so their
 * state survives while a sheet is pushed over them. The backdrop closes it too.
 */
import { useEffect, useRef, type ReactNode } from "react";

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Top of its stack: takes Escape and focus. Default true. */
  active?: boolean;
  /** Covered by a sheet above it. */
  hidden?: boolean;
}

export function Sheet({ title, onClose, children, active = true, hidden = false }: SheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // The latest onClose without re-running the listener (and the focus) on every render.
  const closeNow = useRef(onClose);
  closeNow.current = onClose;

  useEffect(() => {
    if (!active) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNow.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  return (
    <div
      className="sheet-backdrop"
      hidden={hidden}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section role="dialog" aria-modal="true" aria-label={title} className="sheet">
        <header className="sheet-header">
          <h2>{title}</h2>
          <button ref={closeRef} type="button" className="sheet-close" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}
