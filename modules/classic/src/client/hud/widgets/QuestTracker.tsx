/** Active and ready-to-turn-in quests (classic.hud.left). Hidden when there are none. */
import { useSelect } from "../hooks.ts";
import { ProgressBar, useHudLayout, type SlotProps } from "../common.tsx";
import { LEFT_WIDTH } from "../layout.ts";
import { fillPercent, fmtInt } from "../format.ts";
import { C, labelStyle, panelStyle } from "../styles.ts";

export function QuestTracker({ api }: SlotProps) {
  const quests = useSelect(api.hud, (s) =>
    s.quests.filter((q) => q.state === "active" || q.state === "done"),
  );
  const layout = useHudLayout(api);
  if (quests.length === 0) return null;
  return (
    <section
      aria-label="Quest tracker"
      style={{ ...panelStyle, padding: 8, width: LEFT_WIDTH[layout] }}
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
