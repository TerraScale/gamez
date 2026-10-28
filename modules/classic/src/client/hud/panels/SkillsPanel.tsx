/** Skill list: rank, learn with a skill point, assign to a bar slot (panel "skills"). */
import { ACTION } from "../../../actions.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, type SlotProps } from "../common.tsx";
import { fmtDuration, fmtInt } from "../format.ts";
import { SkillIcon } from "../icons.tsx";
import { badgeStyle, C, labelStyle } from "../styles.ts";

export function SkillsPanel({ api }: SlotProps) {
  const skills = useSelect(api.hud, (s) => s.skills);
  const points = useSelect(api.hud, (s) => (s.hero ? s.hero.skillPoints : 0));
  return (
    <PanelFrame
      api={api}
      id="skills"
      title="Skills"
      width={480}
      subtitle={`${fmtInt(points)} skill point${points === 1 ? "" : "s"} to spend`}
    >
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
                <SkillIcon tags={sk.tags} color={sk.rank > 0 ? C.goldBright : C.faint} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>
                    {sk.name} <span style={labelStyle}>{`${sk.rank} / ${sk.maxRank}`}</span>
                  </div>
                  <div style={labelStyle}>{sk.description}</div>
                  <div style={labelStyle}>
                    {`Level ${fmtInt(sk.reqLevel)}`}
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
    </PanelFrame>
  );
}
