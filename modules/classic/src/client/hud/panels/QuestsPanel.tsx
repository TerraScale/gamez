/** Quest log: accept and turn in with the quest giver in reach, in town (panel "quests"). */
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

/** Touch target height (AGENTS.md §10: at least 44px). */
const TOUCH_H = 44;

export function QuestsPanel({ api }: SlotProps) {
  const quests = useSelect(api.hud, (s) => s.quests);
  const inTown = useSelect(api.hud, (s) => s.area?.isTown ?? false);
  const giver = useSelect(api.hud, (s) => s.questGiver ?? null);
  // No giver NPC in the area: the sim does not range-check then, so the buttons stay enabled.
  const inReach = giver === null || giver.inReach;
  const canAct = inTown && inReach;
  const needsWalk = inTown && giver !== null && !giver.inReach;
  const actionable = quests.some((q) => q.state === "available" || q.state === "done");
  let subtitle: string;
  if (!inTown) subtitle = "Return to town to accept or turn in quests";
  else if (!inReach)
    subtitle = `Talk to ${giver?.name ?? "the quest giver"} to accept or turn in quests`;
  else subtitle = "In town: accept and turn in quests here";
  return (
    <PanelFrame api={api} id="quests" title="Quests" width={440} subtitle={subtitle}>
      {needsWalk && actionable && giver !== null ? (
        <div style={{ marginBottom: 8 }}>
          <Btn height={TOUCH_H} onClick={() => api.act(ACTION.interact, { target: giver.entity })}>
            {`Go to ${giver.name}`}
          </Btn>
        </div>
      ) : null}
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
                  height={TOUCH_H}
                  disabled={!canAct}
                  onClick={() => api.act(ACTION.acceptQuest, { quest: q.id })}
                >
                  Accept
                </Btn>
              ) : null}
              {q.state === "done" ? (
                <Btn
                  height={TOUCH_H}
                  disabled={!canAct}
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
