/** Item tooltip under the pointer (ui.hover), comparing with the equipped item it would replace (classic.hud.overlay). */
import type { ItemView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import type { SlotProps } from "../common.tsx";
import {
  EQUIP_LABEL,
  fmtInt,
  fmtSigned,
  pickEquipSlot,
  RARITY_LABEL,
  rarityHex,
} from "../format.ts";
import { C, labelStyle, panelStyle } from "../styles.ts";

export const TOOLTIP_WIDTH = 270;

/** Finds an item by uid among the lists the HUD shows items from (null when absent). */
export function findItem(
  uid: number,
  lists: readonly (readonly (ItemView | null | undefined)[])[],
): ItemView | null {
  for (const list of lists) {
    for (const item of list) if (item && item.uid === uid) return item;
  }
  return null;
}

export function upgradeText(delta: number): string {
  if (delta > 0) return `Upgrade ${fmtSigned(delta)}`;
  if (delta < 0) return `Downgrade ${fmtSigned(delta)}`;
  return "Same score as equipped";
}

export function Tooltip({ api }: SlotProps) {
  const hover = useSelect(api.ui, (u) => u.hover);
  // Selects item lists only (never the hover), so the memo stays valid across hover changes.
  const pool = useSelect(api.hud, (s) => ({
    bag: s.inventory.items.map((i) => i.item),
    equipment: s.equipment,
    stash: s.stash,
    stock: s.vendor ? s.vendor.stock : [],
  }));
  if (!hover) return null;
  const equipped = Object.values(pool.equipment);
  const item = findItem(hover.uid, [pool.bag, equipped, pool.stash, pool.stock]);
  if (!item) return null;
  const slot = pickEquipSlot(item.slots, pool.equipment);
  const current = slot ? (pool.equipment[slot] ?? null) : null;
  const flip = typeof window !== "undefined" && hover.x > window.innerWidth - TOOLTIP_WIDTH - 24;
  const left = Math.max(0, flip ? hover.x - TOOLTIP_WIDTH - 12 : hover.x + 16);
  return (
    <div
      role="tooltip"
      style={{
        ...panelStyle,
        position: "absolute",
        left,
        top: Math.max(0, hover.y + 16),
        width: TOOLTIP_WIDTH,
        padding: 10,
        pointerEvents: "none",
        zIndex: 60,
      }}
    >
      <div style={{ color: rarityHex(item.rarity), fontWeight: 700, fontSize: 14 }}>
        {item.name}
      </div>
      <div
        style={labelStyle}
      >{`${RARITY_LABEL[item.rarity]} · ${item.base} · ilvl ${fmtInt(item.ilvl)} · req ${fmtInt(item.reqLevel)}`}</div>
      <div style={{ marginTop: 6 }}>
        {item.lines.map((line, i) => (
          <div key={`${i}-${line}`}>{line}</div>
        ))}
      </div>
      <div style={{ ...labelStyle, marginTop: 6 }}>
        {`Value ${fmtInt(item.value)} gold`}
        {item.sellPrice > 0 ? ` · sells for ${fmtInt(item.sellPrice)}` : ""}
      </div>
      {item.usable ? null : (
        <div style={{ color: C.danger, fontSize: 12 }}>Requirements not met</div>
      )}
      {item.slots.length === 0 ? null : (
        <div
          style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6, fontSize: 12 }}
        >
          <div>{item.upgrade !== 0 || current ? upgradeText(item.upgrade) : "Empty slot"}</div>
          <div style={labelStyle}>
            {current && current.uid !== item.uid
              ? `Equipped (${EQUIP_LABEL[slot ?? item.slots[0] ?? "weapon"]}): ${current.name}`
              : `Fits: ${item.slots.map((s) => EQUIP_LABEL[s]).join(" / ")}`}
          </div>
        </div>
      )}
    </div>
  );
}
