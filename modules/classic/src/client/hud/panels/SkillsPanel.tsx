/**
 * Skill list: rank, learn with a skill point, assign to a bar slot (panel
 * "skills"). Tabs "Skills | Talents": the Talents tab embeds the class talent
 * tree (TalentsBody, OWNER T-talents) so both live in one panel.
 */
import { useState } from "react";
import { ACTION } from "../../../actions.ts";
import type { SkillView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, type SlotProps } from "../common.tsx";
import { fmtDuration, fmtInt, pluralize } from "../format.ts";
import { SkillIcon } from "../icons.tsx";
import { badgeStyle, C, labelStyle, TOUCH } from "../styles.ts";
import { TalentsBody } from "./TalentsPanel.tsx";

type Tab = "skills" | "talents";

function TabButton({ tab, current, onPick }: { tab: Tab; current: Tab; onPick: (t: Tab) => void }) {
  const label = tab === "skills" ? "Skills" : "Talents";
  return (
    <Btn
      label={`${label} tab`}
      pressed={current === tab}
      height={TOUCH}
      style={{ flex: 1, fontSize: 13 }}
      onClick={() => onPick(tab)}
    >
      {label}
    </Btn>
  );
}

export function SkillsPanel({ api }: SlotProps) {
  const skills = useSelect(api.hud, (s) => s.skills);
  const points = useSelect(api.hud, (s) => (s.hero ? s.hero.skillPoints : 0));
  const [tab, setTab] = useState<Tab>("skills");
  return (
    <PanelFrame
      api={api}
      id="skills"
      title="Skills"
      width={480}
      subtitle={tab === "skills" ? `${pluralize(points, "skill point")} to spend` : undefined}
    >
      <div
        role="group"
        aria-label="Skills or talents"
        style={{ display: "flex", gap: 6, marginBottom: 10 }}
      >
        <TabButton tab="skills" current={tab} onPick={setTab} />
        <TabButton tab="talents" current={tab} onPick={setTab} />
      </div>
      {tab === "talents" ? (
        <TalentsBody api={api} stacked />
      ) : (
        <SkillList api={api} skills={skills} points={points} />
      )}
    </PanelFrame>
  );
}

function SkillList({ api, skills, points }: SlotProps & { skills: SkillView[]; points: number }) {
  return (
    <>
      {skills.length === 0 ? <p style={labelStyle}>No skills yet.</p> : null}
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
        {skills.map((sk) => {
          const learnable = points > 0 && sk.learnable && sk.rank < sk.maxRank;
          const maxed = sk.rank >= sk.maxRank;
          return (
            <li
              key={sk.id}
              style={{
                padding: 10,
                borderRadius: 8,
                border: `1px solid ${sk.onBar !== null ? C.borderStrong : C.border}`,
                background: "rgba(255, 240, 210, 0.04)",
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <SkillIcon
                  skillId={sk.id}
                  tags={sk.tags}
                  color={sk.rank > 0 ? C.goldBright : C.faint}
                  size={36}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>
                    {sk.name} <span style={labelStyle}>{`${sk.rank} / ${sk.maxRank}`}</span>
                  </div>
                  <div style={labelStyle}>{sk.description}</div>
                  {/* The one stat line: required level, mana and cooldown (never repeated in the description). */}
                  <div style={labelStyle}>
                    {`Requires level ${fmtInt(sk.reqLevel)}`}
                    {sk.manaCost > 0 ? ` · ${fmtInt(sk.manaCost)} mana` : ""}
                    {sk.cooldown > 0 ? ` · ${fmtDuration(sk.cooldown)} cooldown` : ""}
                  </div>
                </div>
                {maxed ? (
                  <span style={badgeStyle}>Max</span>
                ) : (
                  <Btn
                    label={`Learn ${sk.name}`}
                    disabled={!learnable}
                    onClick={() => api.act(ACTION.learnSkill, { skill: sk.id })}
                  >
                    +
                  </Btn>
                )}
              </div>
              <div
                role="group"
                aria-label={`Bar slots for ${sk.name}`}
                style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 8 }}
              >
                {[0, 1, 2, 3, 4, 5].map((slot) => (
                  <Btn
                    key={slot}
                    label={`Put ${sk.name} on slot ${slot + 1}`}
                    pressed={sk.onBar === slot}
                    disabled={sk.rank <= 0}
                    minWidth={44}
                    height={44}
                    onClick={() => api.act(ACTION.setSkillBar, { slot, skill: sk.id })}
                  >
                    {String(slot + 1)}
                  </Btn>
                ))}
                {sk.onBar !== null ? (
                  <Btn
                    label={`Clear ${sk.name} from the bar`}
                    height={44}
                    fontSize={12}
                    onClick={() =>
                      api.act(ACTION.setSkillBar, { slot: sk.onBar ?? 0, skill: null })
                    }
                  >
                    Clear
                  </Btn>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
