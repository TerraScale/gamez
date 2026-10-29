/**
 * "More" control of the phone button row: a 44 px button that opens a list of rarely used
 * panels and actions (each row is a 44 px touch target). Controlled: the parent owns `open`, so
 * the open list can be rendered in a test or a QA run without a click. A press anywhere outside
 * the control (the button or the list) closes the list. With `anchorBottom` the list is fixed
 * above the whole bottom bar, so it never covers the orbs row (phone portrait and landscape).
 */
import { useEffect, useRef, type CSSProperties } from "react";
import { panelStyle } from "../styles.ts";
import { Btn } from "../common.tsx";
import { HUD_EDGE } from "../layout.ts";

export interface MoreItem {
  id: string;
  /** Player-facing text of the row, e.g. "Achievements (Y)". */
  text: string;
  /** Button label for assistive tech and the title tooltip. */
  title: string;
  pressed?: boolean;
  onSelect: () => void;
}

/** Anything with a DOM-style `contains` (an element, or a fake in a test). */
export interface ContainsNode {
  contains(node: unknown): boolean;
}

/**
 * The pointer-down listener of an open More menu: closes it unless the press landed inside the
 * control (`getRoot`). Pure apart from `close`, so the rule is testable without a DOM.
 */
export function dismissOutside(
  getRoot: () => ContainsNode | null,
  close: () => void,
): (event: { target: unknown }) => void {
  return (event) => {
    const root = getRoot();
    if (root === null || root.contains(event.target)) return;
    close();
  };
}

/** Viewport-fixed style of the list when it is anchored above the bottom bar. */
export function moreListAnchor(anchorBottom: number): CSSProperties {
  return {
    position: "fixed",
    right: HUD_EDGE,
    bottom: anchorBottom,
    // Short landscape phones and small screens: the list scrolls instead of running off the top.
    maxHeight: `min(60vh, calc(100vh - ${anchorBottom + HUD_EDGE * 2}px))`,
  };
}

export function MoreMenu({
  items,
  open,
  setOpen,
  anchorBottom,
}: {
  items: readonly MoreItem[];
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Px from the viewport bottom where the list's bottom edge sits (above the whole bottom bar). */
  anchorBottom?: number;
}) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = dismissOutside(
      () => rootRef.current,
      () => setOpen(false),
    );
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, setOpen]);
  if (items.length === 0) return null;
  const anchored = anchorBottom === undefined ? {} : moreListAnchor(anchorBottom);
  return (
    <span
      ref={rootRef}
      style={{ position: "relative", display: "inline-flex", pointerEvents: "auto" }}
    >
      <Btn
        label="More panels"
        title="More"
        pressed={open}
        minWidth={44}
        height={44}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </Btn>
      {open ? (
        <div
          role="menu"
          aria-label="More panels"
          style={{
            ...panelStyle,
            ...(anchorBottom === undefined
              ? { position: "absolute", bottom: "100%", right: 0, marginBottom: 6 }
              : anchored),
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: 6,
            minWidth: 200,
            // Short landscape phones: the list scrolls instead of running off the top of the screen.
            overflowY: "auto",
            zIndex: 2,
            ...(anchorBottom === undefined ? { maxHeight: "60vh" } : {}),
          }}
        >
          {items.map((it) => (
            <Btn
              key={it.id}
              label={it.title}
              title={it.title}
              pressed={it.pressed}
              minWidth={188}
              height={44}
              style={{ justifyContent: "flex-start", width: "100%" }}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.text}
            </Btn>
          ))}
        </div>
      ) : null}
    </span>
  );
}
