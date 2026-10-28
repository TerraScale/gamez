/**
 * Gambler panel "gamble" (docs/design/wave-A.md §5.5): one card per offered
 * category with its price. Buy sends classic.gamble {npc, category}; the item
 * lands in the bag (the sim refuses before paying when nothing fits).
 */
import type { Entity } from "@gamez/kernel";
import { ACTION } from "../../../actions.ts";
import type { GambleView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Section, type SlotProps } from "../common.tsx";
import { fmtInt } from "../format.ts";
import { ItemIcon } from "../icons.tsx";
import { C, labelStyle } from "../styles.ts";

/** One offer as the panel shows it. `act` is null when the offer cannot be bought now. */
export interface GambleOption {
  category: GambleView["offers"][number]["category"];
  label: string;
  caption: string;
  enabled: boolean;
  act: {
    name: string;
    payload: { npc: Entity; category: GambleView["offers"][number]["category"] };
  } | null;
}

/** Offers in view order: enabled when the hero has the gold; caption is the price (plus the reason when not). */
export function gambleOptions(view: GambleView): GambleOption[] {
  return view.offers.map((o) => ({
    category: o.category,
    label: o.label,
    caption: o.affordable ? `${fmtInt(o.price)} g` : `${fmtInt(o.price)} g · Not enough gold`,
    enabled: o.affordable,
    act: o.affordable
      ? { name: ACTION.gamble, payload: { npc: view.npc, category: o.category } }
      : null,
  }));
}

export function GamblePanel({ api }: SlotProps) {
  const gamble = useSelect(api.hud, (s) => s.gamble ?? null);
  const gold = useSelect(api.hud, (s) => (s.hero ? s.hero.gold : 0));
  if (!gamble) {
    return (
      <PanelFrame api={api} id="gamble" title="Gambler" width={420}>
        <p style={labelStyle}>Nobody is gambling right now. Find the gambler in town.</p>
      </PanelFrame>
    );
  }
  const options = gambleOptions(gamble);
  return (
    <PanelFrame
      api={api}
      id="gamble"
      title={gamble.name}
      width={460}
      subtitle={`Gold ${fmtInt(gold)}`}
    >
      <p style={{ margin: "0 0 4px", fontStyle: "italic", color: C.muted }}>
        {`"${gamble.greeting}"`}
      </p>
      <Section title="Offers">
        {options.length === 0 ? <p style={labelStyle}>Nothing on offer today.</p> : null}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {options.map((o) => (
            <div
              key={o.category}
              style={{
                flex: "1 1 150px",
                maxWidth: 200,
                minWidth: 150,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                padding: 10,
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: "rgba(255, 240, 210, 0.05)",
              }}
            >
              <ItemIcon category={o.category} color={C.goldBright} size={36} />
              <div style={{ fontWeight: 700, textTransform: "capitalize" }}>{o.label}</div>
              <div style={{ ...labelStyle, textAlign: "center" }}>{o.caption}</div>
              <Btn
                label={`Buy ${o.label}`}
                disabled={!o.enabled}
                onClick={() => {
                  if (o.act) api.act(o.act.name, o.act.payload);
                }}
              >
                Buy
              </Btn>
            </div>
          ))}
        </div>
      </Section>
      <p style={{ ...labelStyle, marginTop: 12 }}>
        Each item is rolled at your level. Rarity is luck: sets and uniques show up now and then.
      </p>
    </PanelFrame>
  );
}
