/** Active and ready-to-turn-in quests (classic.hud.left). Hidden when there are none. */
import { useSelect } from "../hooks.ts";
import { ProgressBar, useCompact, type SlotProps } from "../common.tsx";
import { fillPercent, fmtInt } from "../format.ts";
import { C, labelStyle, panelStyle } from "../styles.ts";

export function QuestTracker({ api }: SlotProps) {
  const quests = useSelect(api.hud, (s) =>
    s.quests.filter((q) => q.state === "active" || q.state === "done"),
  );
  const compact = useCompact(api);
  if (quests.length === 0) return null;
  return (
    <section
      aria-label="Quest tracker"
      style={{ ...panelStyle, padding: 8, width: compact ? 180 : 250 }}
    >
      <div style={{ color: C.goldBright, fontWeight: 700, marginBottom: 4 }}>Quests</div>
      {quests.map((q) => (
        <div key={q.id} style={{ marginBottom: 6 }}>
          <div style={{ fontWeight: 600 }}>{q.name}</div>
          <div style={labelStyle}>
            {q.state === "done"
              ? `Ready: return to ${q.giver}`
              : `${fmtInt(q.progress)} / ${fmtInt(q.count)}`}
          </div>
          <ProgressBar
            pct={fillPercent(q.progress, q.count)}
            color={q.state === "done" ? C.ok : C.gold}
            height={6}
            label={q.name}
          />
        </div>
      ))}
    </section>
  );
}
