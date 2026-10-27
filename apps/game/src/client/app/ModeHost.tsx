import { useEffect, useRef, useState } from "react";
import { Slot, SlotProvider, type ClientModeView, type ClientServices } from "@gamez/ui-host";
import { uiSlots } from "./slots.ts";

export interface ModeHostProps {
  view: ClientModeView;
  services: ClientServices;
  /** Back button: the app unmounts the mode and returns to the picker. */
  onExit: () => void;
}

/**
 * Full-screen container for one running mode. Mounts the view when shown and
 * runs its cleanup when unmounted, including when unmounted before mount ends.
 */
export function ModeHost({ view, services, onExit }: ModeHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    Promise.resolve()
      .then(() => view.mount(el, services))
      .then(
        (done) => {
          // Unmounted while mounting: release right away.
          if (cancelled) done();
          else cleanup = done;
        },
        (err: unknown) => {
          console.error(`mode "${view.modeId}" failed to start`, err);
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        },
      );
    return () => {
      cancelled = true;
      // After React's commit: a mode may unmount its own React root, which
      // React refuses to do synchronously while it is still rendering.
      const done = cleanup;
      if (done) queueMicrotask(done);
    };
  }, [view, services]);

  return (
    <SlotProvider registry={uiSlots}>
      <div ref={hostRef} className="mode-host" />
      <div className="slot-layer">
        <Slot name="hud.left" props={{ modeId: view.modeId }} />
        <Slot name="hud.right" props={{ modeId: view.modeId }} />
      </div>
      {error ? (
        <p className="mode-error" role="alert">
          Could not start {view.modeId}: {error}
        </p>
      ) : null}
      <button type="button" className="back-button" onClick={onExit}>
        Modes
      </button>
    </SlotProvider>
  );
}
