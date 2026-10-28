/** Item tooltip under the pointer (ui.hover), comparing with the equipped item it would replace (classic.hud.overlay). */
import type { ItemView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import type { SlotProps } from "../common.tsx";
import { CATEGORY_LABEL, EQUIP_LABEL, fmtInt, RARITY_LABEL, rarityHex } from "../format.ts";
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

/** Heading of a comparison with the equipped item (the score itself is never shown). */
export function compareHeading(delta: number): string {
  if (delta > 0) return "Better than equipped";
  if (delta < 0) return "Worse than equipped";
  return "Same as equipped";
}

/**
 * Rarity and kind of an item, for the line under its name: "Magic Boots",
 * plus the base name when the item's own name does not already say it
 * ("Magic Boots · Sandals" for "Sturdy Sandals of the Fox", not for "Sandals").
 */
export function itemKindLabel(
  item: Pick<ItemView, "name" | "baseName" | "category" | "rarity">,
): string {
  const kind = `${RARITY_LABEL[item.rarity]} ${CATEGORY_LABEL[item.category]}`;
  const base = item.baseName;
  return base && base !== item.name && base !== CATEGORY_LABEL[item.category]
    ? `${kind} · ${base}`
    : kind;
}

/** One stat difference per entry: gains in the normal colour, losses in red. */
function StatDiffs({ stats }: { stats: { text: string; delta: number }[] }) {
  return (
    <>
      {stats.map((s, i) => (
        <span key={s.text}>
          {i > 0 ? ", " : null}
          <span style={{ color: s.delta < 0 ? C.danger : C.text }}>{s.text}</span>
        </span>
      ))}
    </>
  );
}

function Comparison({ item }: { item: ItemView }) {
  const cmp = item.compare ?? null;
  if (!cmp) return null;
  if (cmp.equipped?.uid === item.uid) {
    return <div style={labelStyle}>Currently equipped</div>;
  }
  const heading =
    cmp.equipped === null ? `Empty ${EQUIP_LABEL[cmp.slot]} slot` : compareHeading(item.upgrade);
  const headingColor =
    cmp.equipped === null ? C.text : item.upgrade > 0 ? C.ok : item.upgrade < 0 ? C.danger : C.text;
  return (
    <>
      <div style={{ color: headingColor, fontWeight: 600 }}>{heading}</div>
      {cmp.equipped ? (
        <>
          <div
            style={labelStyle}
          >{`Equipped (${EQUIP_LABEL[cmp.slot]}): ${cmp.equipped.name}`}</div>
          <div style={{ ...labelStyle, marginTop: 2 }}>
            {cmp.stats.length === 0 ? (
              "No stat changes"
            ) : (
              <>
                vs equipped: <StatDiffs stats={cmp.stats} />
              </>
            )}
          </div>
        </>
      ) : (
        <div style={labelStyle}>{`Fits: ${item.slots.map((s) => EQUIP_LABEL[s]).join(" / ")}`}</div>
      )}
    </>
  );
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
      >{`${itemKindLabel(item)} · ilvl ${fmtInt(item.ilvl)} · req ${fmtInt(item.reqLevel)}`}</div>
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
          <Comparison item={item} />
        </div>
      )}
    </div>
  );
}
