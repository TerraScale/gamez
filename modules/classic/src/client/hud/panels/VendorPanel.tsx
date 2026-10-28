/**
 * NPC trade panel (hud.vendor): smith stock, alchemist potions and scrolls,
 * junk buyer sell list. Healers and quest givers only greet.
 */
import type { ReactNode } from "react";
import { ACTION } from "../../../actions.ts";
import type { NpcRole } from "../../../types.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Section, type SlotProps } from "../common.tsx";
import { fmtInt, rarityHex } from "../format.ts";
import { ItemIcon } from "../icons.tsx";
import { C, labelStyle } from "../styles.ts";
import type { ItemView } from "../../contract.ts";

export const ROLE_TEXT: Record<NpcRole, string> = {
  healer: "Healer",
  smith: "Smith",
  alchemist: "Alchemist",
  junk: "Junk buyer",
  quest: "Quest giver",
};

function ItemLine({ item, right }: { item: ItemView; right?: ReactNode }) {
  const color = rarityHex(item.rarity);
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: "6px 0",
        borderBottom: `1px dashed ${C.faint}`,
      }}
    >
      <ItemIcon category={item.category} color={color} size={28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color, fontWeight: 600 }}>{item.name}</div>
        <div style={labelStyle}>{item.lines.join(" · ")}</div>
      </div>
      {right}
    </div>
  );
}

export function VendorPanel({ api }: SlotProps) {
  const vendor = useSelect(api.hud, (s) =>
    s.vendor
      ? {
          npc: s.vendor.npc,
          name: s.vendor.name,
          role: s.vendor.role,
          greeting: s.vendor.greeting,
          stock: s.vendor.stock,
          potions: s.vendor.potions,
          buyPct: s.vendor.buyPct,
        }
      : null,
  );
  const gold = useSelect(api.hud, (s) => (s.hero ? s.hero.gold : 0));
  const sellable = useSelect(api.hud, (s) =>
    s.inventory.items.map((p) => p.item).filter((i) => i.sellPrice > 0),
  );
  if (!vendor) {
    return (
      <PanelFrame api={api} id="vendor" title="Trade" width={420}>
        <p style={labelStyle}>Nobody is trading right now. Walk up to a merchant in town.</p>
      </PanelFrame>
    );
  }
  return (
    <PanelFrame
      api={api}
      id="vendor"
      title={vendor.name}
      width={460}
      subtitle={`${ROLE_TEXT[vendor.role]} · gold ${fmtInt(gold)}`}
    >
      <p
        style={{ margin: "0 0 4px", fontStyle: "italic", color: C.muted }}
      >{`"${vendor.greeting}"`}</p>
      {vendor.role === "smith" ? (
        <Section title="For sale">
          {vendor.stock.length === 0 ? (
            <p style={labelStyle}>Sold out. Stock returns after the next visit to town.</p>
          ) : null}
          {vendor.stock.map((item, index) => (
            <ItemLine
              key={`${item.uid}-${index}`}
              item={item}
              right={
                <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                  <span
                    style={{ color: C.goldBright, fontWeight: 700 }}
                  >{`${fmtInt(item.price)} g`}</span>
                  <Btn
                    label={`Buy ${item.name}`}
                    disabled={gold < item.price}
                    onClick={() =>
                      api.act(ACTION.buy, { npc: vendor.npc, index, potion: null, count: 1 })
                    }
                  >
                    Buy
                  </Btn>
                </span>
              }
            />
          ))}
        </Section>
      ) : null}
      {vendor.role === "alchemist" ? (
        <Section title="Potions and scrolls">
          {vendor.potions.map((p, index) => (
            <div
              key={p.base}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderBottom: `1px dashed ${C.faint}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{p.name}</div>
              <span style={{ color: C.goldBright, fontWeight: 700 }}>{`${fmtInt(p.price)} g`}</span>
              <Btn
                label={`Buy one ${p.name}`}
                disabled={gold < p.price}
                onClick={() =>
                  api.act(ACTION.buy, { npc: vendor.npc, index, potion: p.base, count: 1 })
                }
              >
                x1
              </Btn>
              <Btn
                label={`Buy five ${p.name}`}
                disabled={gold < p.price * 5}
                onClick={() =>
                  api.act(ACTION.buy, { npc: vendor.npc, index, potion: p.base, count: 5 })
                }
              >
                x5
              </Btn>
            </div>
          ))}
        </Section>
      ) : null}
      {vendor.role === "junk" ? (
        <Section title="Sell">
          <p style={labelStyle}>{`Pays ${fmtInt(vendor.buyPct)}% of an item's value.`}</p>
          {sellable.length === 0 ? (
            <p style={labelStyle}>Nothing in your bag is worth selling.</p>
          ) : null}
          {sellable.map((item) => (
            <ItemLine
              key={item.uid}
              item={item}
              right={
                <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                  <span
                    style={{ color: C.goldBright, fontWeight: 700 }}
                  >{`${fmtInt(item.sellPrice)} g`}</span>
                  <Btn
                    label={`Sell ${item.name}`}
                    onClick={() => api.act(ACTION.sell, { npc: vendor.npc, uid: item.uid })}
                  >
                    Sell
                  </Btn>
                </span>
              }
            />
          ))}
        </Section>
      ) : null}
      {vendor.role === "healer" || vendor.role === "quest" ? (
        <p style={labelStyle}>
          {vendor.role === "healer"
            ? "Healing is automatic while you are in town."
            : "Quests are handled in the quest panel."}
        </p>
      ) : null}
    </PanelFrame>
  );
}
