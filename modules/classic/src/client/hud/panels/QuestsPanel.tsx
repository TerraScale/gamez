/** Quest log: accept and turn in while in town (panel "quests"). */
import { ACTION } from "../../../actions.ts";
import type { QuestView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, ProgressBar, type SlotProps } from "../common.tsx";
import { fillPercent, fmtInt } from "../format.ts";
import { badgeStyle, C, labelStyle } from "../styles.ts";

const STATE_TEXT: Record<QuestView["state"], string> = {
  available: "Available",
  active: "In progress",
  done: "Ready to turn in",
  completed: "Completed",
};

export function QuestsPanel({ api }: SlotProps) {
  const quests = useSelect(api.hud, (s) => s.quests);
  const inTown = useSelect(api.hud, (s) => s.area?.isTown ?? false);
  return (
    <PanelFrame
      api={api}
      id="quests"
      title="Quests"
      width={440}
      subtitle={
        inTown
          ? "In town: accept and turn in quests here"
          : "Return to town to accept or turn in quests"
      }
    >
      {quests.length === 0 ? <p style={labelStyle}>No quests yet.</p> : null}
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {quests.map((q) => (
          <li
            key={q.id}
            style={{
              padding: 10,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: "rgba(255, 240, 210, 0.04)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div style={{ fontWeight: 700 }}>{q.name}</div>
              <span style={badgeStyle}>{STATE_TEXT[q.state]}</span>
            </div>
            <div style={labelStyle}>{`${q.description} · from ${q.giver}`}</div>
            <div style={{ ...labelStyle, marginTop: 4 }}>{`Reward: ${q.reward}`}</div>
            {q.state === "active" || q.state === "done" ? (
              <div style={{ marginTop: 6 }}>
                <ProgressBar
                  pct={fillPercent(q.progress, q.count)}
                  color={q.state === "done" ? C.ok : C.gold}
                  label={q.name}
                />
                <div style={labelStyle}>{`${fmtInt(q.progress)} / ${fmtInt(q.count)}`}</div>
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {q.state === "available" ? (
                <Btn
                  disabled={!inTown}
                  onClick={() => api.act(ACTION.acceptQuest, { quest: q.id })}
                >
                  Accept
                </Btn>
              ) : null}
              {q.state === "done" ? (
                <Btn
                  disabled={!inTown}
                  pressed
                  onClick={() => api.act(ACTION.completeQuest, { quest: q.id })}
                >
                  Turn in
                </Btn>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </PanelFrame>
  );
}
