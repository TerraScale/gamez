/** Character sheet: attributes with + buttons, derived stats and resists (panel "character"). */
import { ACTION } from "../../../actions.ts";
import { ATTRS } from "../../../types.ts";
import type { HeroView } from "../../contract.ts";
import { ELEMENT_COLOR, hex } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Row, Section, type SlotProps } from "../common.tsx";
import { ATTR_LABEL, fmtInt, fmtPct, fmtRegen, pluralize } from "../format.ts";
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

function CharacterBody({ api, hero }: SlotProps & { hero: HeroView }) {
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
          <Row key={a} style={{ justifyContent: "space-between", minHeight: 44 }}>
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
      <Section title="Derived">
        <Stat label="Life" value={fmtInt(hero.lifeMax)} />
        <Stat label="Mana" value={fmtInt(hero.manaMax)} />
        <Stat label="Life regen" value={fmtRegen(sheet.lifeRegen)} />
        <Stat label="Mana regen" value={fmtRegen(sheet.manaRegen)} />
        <Stat label="Armor" value={fmtInt(hero.armor)} />
        <Stat label="Damage" value={`${fmtInt(hero.dmgMin)}-${fmtInt(hero.dmgMax)}`} />
        <Stat label="To hit" value={fmtInt(hero.toHit)} />
        <Stat label="Critical chance" value={fmtPct(hero.critPct)} />
        <Stat label="Attack speed" value={fmtPct(hero.attackSpeed)} />
        <Stat label="Cast speed" value={fmtPct(hero.castSpeed)} />
        <Stat label="Move speed" value={fmtPct(hero.moveSpeed)} />
        <Stat label="Magic find" value={fmtPct(sheet.magicFind)} />
        <Stat label="Gold find" value={fmtPct(sheet.goldFind)} />
        <Stat label="Light radius" value={pluralize(sheet.lightRadius, "tile")} />
        <Stat label="Life on kill" value={fmtInt(sheet.lifeOnKill)} />
        <Stat label="Mana on kill" value={fmtInt(sheet.manaOnKill)} />
        <Stat label="All skills" value={`+${fmtInt(sheet.allSkills)}`} />
        <Stat label="Potion effect" value={fmtPct(sheet.potionPct)} />
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
    </>
  );
}

export function CharacterPanel({ api }: SlotProps) {
  const hero = useSelect(api.hud, (s) => s.hero);
  return (
    <PanelFrame
      api={api}
      id="character"
      title="Character"
      width={380}
      subtitle={hero ? `${hero.name} · ${hero.className} · level ${hero.level}` : undefined}
    >
      {hero ? <CharacterBody api={api} hero={hero} /> : <p style={labelStyle}>No hero yet.</p>}
    </PanelFrame>
  );
}
