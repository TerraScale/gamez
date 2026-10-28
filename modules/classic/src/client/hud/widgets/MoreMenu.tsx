/**
 * "More" control of the phone button row: a 44 px button that opens a list of rarely used
 * panels and actions above the bar (each row is a 44 px touch target). Controlled: the parent
 * owns `open`, so the open list can be rendered in a test or a QA run without a click.
 */
import { panelStyle } from "../styles.ts";
import { Btn } from "../common.tsx";

export interface MoreItem {
  id: string;
  /** Player-facing text of the row, e.g. "Achievements (Y)". */
  text: string;
  /** Button label for assistive tech and the title tooltip. */
  title: string;
  pressed?: boolean;
  onSelect: () => void;
}

export function MoreMenu({
  items,
  open,
  setOpen,
}: {
  items: readonly MoreItem[];
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  if (items.length === 0) return null;
  return (
    <span style={{ position: "relative", display: "inline-flex", pointerEvents: "auto" }}>
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
            position: "absolute",
            bottom: "100%",
            right: 0,
            marginBottom: 6,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: 6,
            minWidth: 200,
            zIndex: 2,
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
