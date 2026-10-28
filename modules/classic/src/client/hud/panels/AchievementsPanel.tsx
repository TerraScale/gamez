/**
 * Achievements panel (wave A, docs/design/wave-A.md §9) — OWNER: T-achievements.
 * Panel "achievements". Rows come from api.hud.achievements (AchievementsView);
 * the title choice is display-only and stored client-side (localStorage key
 * "gamez.classic.title.v1", every access in try/catch).
 */
import { useState } from "react";
import { ACHIEVEMENTS } from "../../../content/achievements.ts";
import type { AchievementView } from "../../contract.ts";
import { Btn, PanelFrame, ProgressBar, type SlotProps } from "../common.tsx";
import { fillPercent, fmtDuration, fmtInt } from "../format.ts";
import { useSelect } from "../hooks.ts";
import { badgeStyle, C, labelStyle } from "../styles.ts";

export const TITLE_STORAGE_KEY = "gamez.classic.title.v1";

type Filter = "all" | "unlocked" | "locked";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unlocked", label: "Unlocked" },
  { id: "locked", label: "Locked" },
];

/** The stored display title, or "" (no storage, blocked storage or nothing chosen). */
export function readStoredTitle(): string {
  try {
    return globalThis.localStorage?.getItem(TITLE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredTitle(title: string): void {
  try {
    globalThis.localStorage?.setItem(TITLE_STORAGE_KEY, title);
  } catch {
    // Private windows and blocked storage: the choice simply does not persist.
  }
}

/** Reward titles of every achievement, in registry order of the content table. */
function titleOptions(): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const [id, proto] of Object.entries(ACHIEVEMENTS).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (proto.reward.title) out.push({ id, title: proto.reward.title });
  }
  return out;
}

function Glyph({ unlocked, hidden }: { unlocked: boolean; hidden: boolean }) {
  const color = unlocked ? C.goldBright : C.faint;
  return (
    <svg width={36} height={36} viewBox="0 0 36 36" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path
        d="M11 3 L18 14 L25 3 L28 3 L21 16 L11 16 L4 3 Z"
        fill={unlocked ? "rgba(217, 173, 82, 0.35)" : "rgba(109, 99, 83, 0.25)"}
        stroke={color}
        strokeWidth={1.2}
      />
      <circle cx={18} cy={24} r={9} fill="none" stroke={color} strokeWidth={1.6} />
      <text
        x={18}
        y={28}
        textAnchor="middle"
        fontSize={hidden ? 11 : 12}
        fontWeight={700}
        fill={color}
      >
        {hidden ? "?" : unlocked ? "★" : ""}
      </text>
    </svg>
  );
}

function rowProgress(a: AchievementView): number {
  return fillPercent(a.progress, a.target);
}

export function AchievementsPanel({ api }: SlotProps) {
  const view = useSelect(api.hud, (s) => s.achievements ?? null);
  const [filter, setFilter] = useState<Filter>("all");
  const [title, setTitle] = useState<string>(() => readStoredTitle());

  if (!view) {
    return (
      <PanelFrame api={api} id="achievements" title="Achievements" width={420}>
        <p style={labelStyle}>No achievements in this game.</p>
      </PanelFrame>
    );
  }

  const unlockedIds = new Set(view.list.filter((a) => a.unlocked).map((a) => a.id));
  const options = titleOptions().filter((o) => unlockedIds.has(o.id));
  const chosenTitle = options.some((o) => o.title === title) ? title : "";
  const rows = view.list
    .filter((a) => filter === "all" || (filter === "unlocked") === a.unlocked)
    .slice()
    .sort((a, b) => Number(b.unlocked) - Number(a.unlocked));

  const choose = (next: string) => {
    setTitle(next);
    writeStoredTitle(next);
  };

  return (
    <PanelFrame
      api={api}
      id="achievements"
      title="Achievements"
      width={420}
      subtitle={`${view.unlocked} / ${view.total} unlocked`}
    >
      <div role="tablist" aria-label="Filter" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <Btn
            key={f.id}
            pressed={filter === f.id}
            label={`Show ${f.label}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </Btn>
        ))}
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ ...labelStyle, marginBottom: 4 }}>
          {chosenTitle ? `Title: ${chosenTitle}` : "Title: none"}
        </div>
        {options.length === 0 ? (
          <p style={labelStyle}>Unlock an achievement with a title reward to choose one.</p>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Btn pressed={chosenTitle === ""} label="Show no title" onClick={() => choose("")}>
              None
            </Btn>
            {options.map((o) => (
              <Btn
                key={o.id}
                pressed={chosenTitle === o.title}
                label={`Show title ${o.title}`}
                onClick={() => choose(o.title)}
              >
                {o.title}
              </Btn>
            ))}
          </div>
        )}
      </div>

      {rows.length === 0 ? <p style={{ ...labelStyle, marginTop: 10 }}>Nothing here yet.</p> : null}
      <ul
        style={{
          listStyle: "none",
          margin: "10px 0 0",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {rows.map((a) => (
          <li
            key={a.id}
            style={{
              display: "flex",
              gap: 10,
              padding: 10,
              borderRadius: 8,
              border: `1px solid ${a.unlocked ? C.borderStrong : C.border}`,
              background: a.unlocked ? "rgba(243, 210, 122, 0.07)" : "rgba(255, 240, 210, 0.03)",
              opacity: a.unlocked ? 1 : 0.85,
            }}
          >
            <Glyph unlocked={a.unlocked} hidden={a.name === "???"} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <div style={{ fontWeight: 700, color: a.unlocked ? C.goldBright : C.text }}>
                  {a.name}
                </div>
                <span style={badgeStyle}>{a.unlocked ? "Unlocked" : "Locked"}</span>
              </div>
              <div style={labelStyle}>{a.description}</div>
              <div style={{ marginTop: 6 }}>
                <ProgressBar
                  pct={rowProgress(a)}
                  color={a.unlocked ? C.ok : C.gold}
                  label={`${a.name} progress`}
                  height={8}
                />
              </div>
              <div
                style={{
                  ...labelStyle,
                  marginTop: 4,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span>{`${fmtInt(Math.min(a.progress, a.target))} / ${fmtInt(a.target)}`}</span>
                <span>
                  {a.unlocked ? `Unlocked after ${fmtDuration(a.at)}` : `Reward: ${a.rewardText}`}
                </span>
              </div>
              {a.unlocked ? <div style={labelStyle}>{`Reward: ${a.rewardText}`}</div> : null}
            </div>
          </li>
        ))}
      </ul>
    </PanelFrame>
  );
}
