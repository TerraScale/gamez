/**
 * Wave A panel "rift" (docs/design/wave-A.md §7, §10.3) — OWNER: T-rift.
 * Locked state, the level picker with Open (at the obelisk), the active run
 * (progress, timer, guardian, Leave) and the best run and history.
 */
import { useState } from "react";
import { ACTION, type ActionPayloads } from "../../../actions.ts";
import type { RiftRecord } from "../../../resources.ts";
import { Btn, PanelFrame, ProgressBar, Section, type SlotProps } from "../common.tsx";
import { fmtInt, TICKS_PER_SECOND } from "../format.ts";
import { badgeStyle, C, labelStyle } from "../styles.ts";
import { useSelect } from "../hooks.ts";
import type { RiftView } from "../../contract.ts";

/** Run time as mm:ss from ticks. */
function clock(ticks: number): string {
  const total = Math.max(0, Math.floor(ticks / TICKS_PER_SECOND));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function resultOf(r: RiftRecord): string {
  if (r.completed) return "Completed";
  return r.reason === "death" ? "Died" : "Left";
}

export function RiftPanel({ api }: SlotProps) {
  const rift = useSelect(api.hud, (s): RiftView | null => s.rift ?? null);
  const [picked, setPicked] = useState(1);

  if (!rift) {
    return (
      <PanelFrame api={api} id="rift" title="The Rift" width={420}>
        <p style={labelStyle}>Nothing to show yet. Start a hero first.</p>
      </PanelFrame>
    );
  }

  if (!rift.unlocked) {
    return (
      <PanelFrame api={api} id="rift" title="The Rift" width={420} subtitle="Sealed">
        <p style={{ margin: 0, fontWeight: 700 }}>{rift.unlockText}</p>
        <p style={labelStyle}>
          The obelisk stands in the town, beside the waypoint. Its seal breaks once the Hollow King
          falls.
        </p>
        {rift.best ? <RunSummary best={rift.best} /> : null}
      </PanelFrame>
    );
  }

  if (rift.active) {
    const a = rift.active;
    return (
      <PanelFrame
        api={api}
        id="rift"
        title="The Rift"
        width={420}
        subtitle={`Rift level ${fmtInt(a.level)}`}
      >
        <Section title="Progress">
          <ProgressBar pct={a.progressPct} color={C.xp} label="Rift progress" height={12} />
          <p style={labelStyle}>{`${fmtInt(a.progressPct)}% toward the guardian`}</p>
        </Section>
        <Section title="Run">
          <p style={{ margin: 0 }}>
            {`Time left: ${a.ticksLeft > 0 ? clock(a.ticksLeft) : "over time"}`}
          </p>
          <p style={{ margin: "4px 0 0", color: a.done ? C.ok : C.muted }}>
            {a.done
              ? "The guardian has fallen."
              : a.guardianAlive
                ? "The guardian is near. Slay it to finish the run."
                : "Kill monsters to draw out the guardian."}
          </p>
          {a.ticksLeft <= 0 ? (
            <p style={labelStyle}>Over time: rewards are halved, the score has no time bonus.</p>
          ) : null}
        </Section>
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn label="Leave the rift" onClick={() => api.act(ACTION.leaveRift, {})}>
            Leave the rift
          </Btn>
        </div>
        <p style={labelStyle}>Leaving or dying before the guardian falls ends the run as failed.</p>
        <History rift={rift} />
      </PanelFrame>
    );
  }

  const choice = rift.levels.find((l) => l.level === picked) ?? rift.levels[0];
  const canOpen = rift.obelisk !== 0 && choice !== undefined && choice.affordable;
  const openPayload: ActionPayloads["classic.openRift"] | null =
    choice && rift.obelisk !== 0 ? { target: rift.obelisk, level: choice.level } : null;
  return (
    <PanelFrame
      api={api}
      id="rift"
      title="The Rift"
      width={420}
      subtitle={`Deepest cleared level: ${fmtInt(rift.maxCompleted)}`}
    >
      <Section title="Choose a level">
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
          {rift.levels.map((l) => {
            const selected = choice?.level === l.level;
            return (
              <li key={l.level}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setPicked(l.level)}
                  style={{
                    width: "100%",
                    minHeight: 44,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1px solid ${selected ? C.borderStrong : C.border}`,
                    background: selected ? C.buttonActive : "rgba(255, 240, 210, 0.04)",
                    color: C.text,
                    textAlign: "left",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  <span style={{ flex: 1, fontWeight: 700 }}>{`Level ${fmtInt(l.level)}`}</span>
                  <span style={{ color: C.muted, fontSize: 13 }}>
                    {`monsters ${fmtInt(l.monsterLevel)}`}
                  </span>
                  <span style={{ color: l.affordable ? C.goldBright : C.danger, fontSize: 13 }}>
                    {`${fmtInt(l.fee)} gold`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>
      <div
        style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        <Btn
          label={`Open Rift level ${choice ? fmtInt(choice.level) : ""}`}
          disabled={!canOpen || openPayload === null}
          onClick={() => {
            if (openPayload) api.act(ACTION.openRift, openPayload);
          }}
        >
          Open the Rift
        </Btn>
        {rift.obelisk === 0 ? (
          <span style={labelStyle}>Stand next to the Rift obelisk to open a rift.</span>
        ) : null}
        {rift.obelisk !== 0 && choice && !choice.affordable ? (
          <span style={badgeStyle}>Not enough gold</span>
        ) : null}
      </div>
      {choice ? (
        <p
          style={labelStyle}
        >{`The entry fee is paid when the rift opens. Level ${fmtInt(choice.level)} monsters are level ${fmtInt(choice.monsterLevel)}.`}</p>
      ) : null}
      {rift.best ? <RunSummary best={rift.best} /> : null}
      <History rift={rift} />
    </PanelFrame>
  );
}

function RunSummary({ best }: { best: RiftRecord }) {
  return (
    <Section title="Best run">
      <p style={{ margin: 0 }}>
        {`Level ${fmtInt(best.level)} in ${clock(best.ticks)} - score ${fmtInt(best.score)}`}
      </p>
    </Section>
  );
}

function History({ rift }: { rift: RiftView }) {
  if (rift.history.length === 0) {
    return (
      <Section title="History">
        <p style={labelStyle}>No runs yet.</p>
      </Section>
    );
  }
  return (
    <Section title="History">
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
        <div style={{ display: "flex", gap: 8, color: C.muted }}>
          <span style={{ width: 64 }}>Level</span>
          <span style={{ width: 56 }}>Time</span>
          <span style={{ flex: 1 }}>Score</span>
          <span>Result</span>
        </div>
        {rift.history.map((r) => (
          <div key={r.run} style={{ display: "flex", gap: 8 }}>
            <span style={{ width: 64 }}>{fmtInt(r.level)}</span>
            <span style={{ width: 56 }}>{clock(r.ticks)}</span>
            <span style={{ flex: 1 }}>{fmtInt(r.score)}</span>
            <span style={{ color: r.completed ? C.ok : C.danger }}>{resultOf(r)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
