/**
 * Character sheet (panel "character"): attributes with + buttons, offence and defence blocks,
 * resistances, the damage table of the bar skills (DpsView) and where the stats come from.
 */
import { ACTION } from "../../../actions.ts";
import { ATTRS } from "../../../types.ts";
import type { DpsView, HeroView } from "../../contract.ts";
import { ELEMENT_COLOR, hex } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Row, Section, type SlotProps } from "../common.tsx";
import {
  ATTR_LABEL,
  fmtInt,
  fmtPct,
  fmtPerSecond,
  fmtRate,
  fmtRegen,
  pluralize,
} from "../format.ts";
import { C, labelStyle } from "../styles.ts";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        padding: "3px 0",
        borderBottom: `1px dashed ${C.faint}`,
      }}
    >
      <span style={labelStyle}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

/** The bar skills' damage: one row per skill, the best one marked. */
export function DpsTable({ dps }: { dps: DpsView }) {
  if (dps.skills.length === 0) {
    return <p style={labelStyle}>No damage skills on the bar yet.</p>;
  }
  // Numeric columns keep a left gap and never wrap, so a narrow panel
  // cannot run "Casts", "DPS" and "Mana" together.
  const head = {
    ...labelStyle,
    fontWeight: 700,
    textAlign: "right" as const,
    padding: "4px 0 4px 10px",
    whiteSpace: "nowrap" as const,
  };
  const num = {
    textAlign: "right" as const,
    paddingLeft: 10,
    whiteSpace: "nowrap" as const,
    borderTop: `1px dashed ${C.faint}`,
  };
  return (
    <table
      aria-label="Damage per second of the bar skills"
      style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
    >
      <thead>
        <tr>
          <th style={{ ...head, textAlign: "left", paddingLeft: 0 }}>Skill</th>
          <th style={head}>Avg hit</th>
          <th style={head}>Casts</th>
          <th style={head}>DPS</th>
          <th style={head}>Mana</th>
        </tr>
      </thead>
      <tbody>
        {dps.skills.map((s) => {
          const best = s.dps > 0 && s.dps === dps.best;
          return (
            <tr
              key={s.skill}
              data-best={best ? "true" : undefined}
              style={{ color: best ? C.goldBright : C.text }}
            >
              <td style={{ padding: "4px 0", borderTop: `1px dashed ${C.faint}` }}>{s.name}</td>
              <td style={num}>{fmtInt(s.avgHit)}</td>
              <td style={num}>{fmtPerSecond(s.perSecond)}</td>
              <td style={{ ...num, fontWeight: 700 }}>{fmtInt(s.dps)}</td>
              <td style={num}>{fmtRate(s.manaPerSecond)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Where the hero's stats come from: items, sets, talents and buffs, with short lines. */
export function SourceList({ dps }: { dps: DpsView }) {
  return (
    <>
      {dps.sources.map((s) => (
        <div key={s.source} style={{ marginBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>{s.source}</div>
          {s.lines.length === 0 ? (
            <div style={labelStyle}>None</div>
          ) : (
            s.lines.map((line) => (
              <div key={line} style={{ fontSize: 12, color: C.muted }}>
                {line}
              </div>
            ))
          )}
        </div>
      ))}
    </>
  );
}

function CharacterBody({ api, hero, dps }: SlotProps & { hero: HeroView; dps: DpsView | null }) {
  const sheet = hero.sheet;
  const canSpend = hero.statPoints > 0;
  return (
    <>
      <Row style={{ justifyContent: "space-between" }}>
        <span style={labelStyle}>Gold</span>
        <span style={{ fontWeight: 700, color: hex(0xf0c419) }}>{fmtInt(hero.gold)}</span>
        <span style={labelStyle}>Town portals</span>
        <span style={{ fontWeight: 600 }}>{fmtInt(hero.tpScrolls)}</span>
      </Row>
      <Row style={{ justifyContent: "space-between" }}>
        <span style={labelStyle}>Attribute points</span>
        <span style={{ fontWeight: 700, color: canSpend ? C.goldBright : C.text }}>
          {fmtInt(hero.statPoints)}
        </span>
        <span style={labelStyle}>Skill points</span>
        <span style={{ fontWeight: 700, color: hero.skillPoints > 0 ? C.goldBright : C.text }}>
          {fmtInt(hero.skillPoints)}
        </span>
      </Row>
      <Section title="Attributes">
        {ATTRS.map((a) => (
          // The gap keeps the 44 px "+" buttons apart on touch screens.
          <Row key={a} style={{ justifyContent: "space-between", minHeight: 44, marginBottom: 8 }}>
            <span>{ATTR_LABEL[a]}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, minWidth: 40, textAlign: "right" }}>
                {fmtInt(hero.attrs[a])}
              </span>
              {canSpend ? (
                <Btn
                  label={`Add a point to ${ATTR_LABEL[a]}`}
                  minWidth={44}
                  height={44}
                  onClick={() => api.act(ACTION.allocateStat, { attr: a, points: 1 })}
                >
                  +
                </Btn>
              ) : null}
            </span>
          </Row>
        ))}
      </Section>
      <Section title="Damage">
        {dps ? (
          <DpsTable dps={dps} />
        ) : (
          <>
            <Stat label="Damage" value={`${fmtInt(hero.dmgMin)}-${fmtInt(hero.dmgMax)}`} />
            <Stat label="To hit" value={fmtInt(hero.toHit)} />
          </>
        )}
        <Stat label="Critical chance" value={fmtPct(hero.critPct)} />
        <Stat label="Attack speed" value={fmtPct(hero.attackSpeed)} />
        <Stat label="Cast speed" value={fmtPct(hero.castSpeed)} />
        <Stat label="Move speed" value={fmtPct(hero.moveSpeed)} />
        <Stat label="Magic find" value={fmtPct(sheet.magicFind)} />
        <Stat label="Gold find" value={fmtPct(sheet.goldFind)} />
        <Stat label="Life on kill" value={fmtInt(sheet.lifeOnKill)} />
        <Stat label="Mana on kill" value={fmtInt(sheet.manaOnKill)} />
        <Stat label="All skills" value={`+${fmtInt(sheet.allSkills)}`} />
        <Stat label="Potion effect" value={fmtPct(sheet.potionPct)} />
        <Stat label="Light radius" value={pluralize(sheet.lightRadius, "tile")} />
      </Section>
      <Section title="Defence">
        <Stat label="Life" value={fmtInt(hero.lifeMax)} />
        <Stat label="Mana" value={fmtInt(hero.manaMax)} />
        <Stat label="Life regen" value={fmtRegen(sheet.lifeRegen)} />
        <Stat label="Mana regen" value={fmtRegen(sheet.manaRegen)} />
        <Stat label="Armor" value={fmtInt(hero.armor)} />
        {dps ? (
          <Stat label="Effective life (physical hit)" value={fmtInt(dps.effectiveLife)} />
        ) : null}
      </Section>
      <Section title="Resistances">
        {(["fire", "cold", "lightning", "poison"] as const).map((el) => (
          <Stat key={el} label={el[0]?.toUpperCase() + el.slice(1)} value={fmtPct(hero.res[el])} />
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          {(["fire", "cold", "lightning", "poison"] as const).map((el) => (
            <span
              key={el}
              aria-hidden="true"
              style={{ width: 10, height: 10, borderRadius: 2, background: hex(ELEMENT_COLOR[el]) }}
            />
          ))}
        </div>
      </Section>
      {dps ? (
        <Section title="Sources">
          <SourceList dps={dps} />
        </Section>
      ) : null}
    </>
  );
}

export function CharacterPanel({ api }: SlotProps) {
  const hero = useSelect(api.hud, (s) => s.hero);
  const dps = useSelect(api.hud, (s) => s.dps ?? null);
  const title = useSelect(api.hud, (s) => s.achievements?.title ?? "");
  const subtitle = hero
    ? [`${hero.name} · ${hero.className} · level ${hero.level}`, title ? `"${title}"` : ""]
        .filter((x) => x !== "")
        .join(" · ")
    : undefined;
  return (
    <PanelFrame api={api} id="character" title="Character" width={380} subtitle={subtitle}>
      {hero ? (
        <CharacterBody api={api} hero={hero} dps={dps} />
      ) : (
        <p style={labelStyle}>No hero yet.</p>
      )}
    </PanelFrame>
  );
}
