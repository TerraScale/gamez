/** Modal sheet for the account, leaderboards and guild screens. Escape and the backdrop close it. */
import { useEffect, useRef, type ReactNode } from "react";

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Sheet({ title, onClose, children }: SheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
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
