/**
 * "While you were away" card (docs/design/offline-idle.md §6). Shown after an
 * offline grant with at least one credited minute; read from awayStore through
 * a selector (game state stays out of React state). Dismissed by its Close
 * button. Sits under the top bar, fits 375 px.
 */
import { awaySpan, awayStore, type AwayView } from "../../hudModel.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useHudInsets } from "../common.tsx";
import { fmtInt } from "../format.ts";
import { C, panelStyle, titleStyle } from "../styles.ts";

/**
 * The note under a gold line of 0 with upkeep: online Idle spends what it finds
 * on potions, scrolls and repairs, and the offline gold is that same net.
 */
export const UPKEEP_ATE_GOLD =
  "Potions, scrolls and repairs cost what Idle finds here, as they do online";

/** Closes the card (the Close button and tests use it). */
export function dismissAway(): void {
  awayStore.set(null);
}

/** The card's text lines, in display order. Pure, so tests read the content without the DOM. */
export function awayLines(v: AwayView): {
  time: string;
  lines: string[];
  quests: string[];
  hint: string;
} {
  const capped = v.awayMs > v.creditedMs;
  const time =
    `Away ${awaySpan(v.awayMs)} · credited ${awaySpan(v.creditedMs)}` +
    (capped ? ` (capped at ${awaySpan(v.capMs)})` : "");
  const lines: string[] = [
    `${fmtInt(v.kills)} kills`,
    `+${fmtInt(v.xp)} XP (${v.xpPct}% offline rate)`,
  ];
  // Gold is the measured online net (offline-idle.md §3): what Idle finds minus
  // what it pays for potions, scrolls and repairs. Show both, so a grant of 0
  // gold reads as "upkeep used it up" rather than as a bug.
  const upkeepNote =
    v.upkeep > 0
      ? v.found !== undefined
        ? ` (found ${fmtInt(v.found)}, net of ${fmtInt(v.upkeep)} upkeep)`
        : ` (net of ${fmtInt(v.upkeep)} upkeep)`
      : "";
  lines.push(`+${fmtInt(v.gold)} gold${v.goldPct !== 100 ? ` (${v.goldPct}%)` : ""}${upkeepNote}`);
  if (v.gold === 0 && v.upkeep > 0) lines.push(UPKEEP_ATE_GOLD);
  if (v.items > 0) lines.push(`${fmtInt(v.items)} items → stash`);
  if (v.levels > 0) lines.push(`+${fmtInt(v.levels)} ${v.levels === 1 ? "level" : "levels"}`);
  // The rates in force (offline-idle.md §3): XP is the admin tunable, gold and items are data.
  lines.push(`Offline rates: XP ${v.xpPct}% · gold ${v.goldPct}% · items ${v.itemPct}%`);
  // A quest done offline is not turned in offline: Idle turns it in at the quest giver later.
  const quests = v.quests.map((q) =>
    q.done ? `${q.name}: done, turn in at the quest giver` : `${q.name}: ${q.text}`,
  );
  if (v.questsMore > 0) quests.push(`and ${fmtInt(v.questsMore)} more`);
  const hint =
    v.source === "rate" ? "Measured from your Idle rate" : "Estimated: not enough Idle history yet";
  return { time, lines, quests, hint };
}

export function AwaySummary() {
  const view = useSelect(awayStore, (v) => v);
  const insets = useHudInsets();
  if (!view) return null;
  const text = awayLines(view);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: insets.top + 8,
        display: "flex",
        justifyContent: "center",
        padding: "0 16px",
        pointerEvents: "none",
        zIndex: 6,
      }}
    >
      <section
        role="dialog"
        aria-label="While you were away"
        style={{
          ...panelStyle,
          width: "min(360px, 100%)",
          maxHeight: "100%",
          overflowY: "auto",
          padding: 14,
          pointerEvents: "auto",
          background: C.panelSolid,
        }}
      >
        <h2 style={{ ...titleStyle, fontSize: 16 }}>While you were away</h2>
        <p style={{ color: C.muted, margin: "6px 0 0", fontSize: 12 }}>{text.time}</p>
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 4 }}>
          {text.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {text.quests.length > 0 ? (
          <ul
            aria-label="Quest progress"
            style={{
              listStyle: "none",
              margin: "10px 0 0",
              padding: "8px 0 0",
              borderTop: `1px solid ${C.border}`,
              display: "grid",
              gap: 4,
              color: C.ok,
            }}
          >
            {text.quests.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <p style={{ color: C.faint, margin: "10px 0 0", fontSize: 12 }}>{text.hint}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <Btn label="Close" title="Close" height={44} minWidth={96} onClick={dismissAway}>
            Close
          </Btn>
        </div>
      </section>
    </div>
  );
}
