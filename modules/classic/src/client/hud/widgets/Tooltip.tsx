/** Item tooltip under the pointer (ui.hover), comparing with the equipped item it would replace (classic.hud.overlay). */
import type { ItemView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { ProgressBar, type SlotProps } from "../common.tsx";
import { nameShowsUpgrade } from "../../describe.ts";
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

/** Durability line text: "Durability 40 / 60", or "Broken" (red) when cur is 0. */
export function durabilityText(d: { cur: number; max: number }, broken: boolean): string {
  return broken
    ? "Broken: no stats until repaired"
    : `Durability ${fmtInt(d.cur)} / ${fmtInt(d.max)}`;
}

/** Socket count and filled count for the sockets row ("2 of 3 sockets filled"). */
export function socketSummary(sockets: readonly { gem: string | null }[]): string {
  const filled = sockets.filter((s) => s.gem !== null).length;
  return `${fmtInt(filled)} of ${fmtInt(sockets.length)} ${sockets.length === 1 ? "socket" : "sockets"} filled`;
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

/** Set piece block: the set name, pieces worn (check) or not (cross), bonuses active or not. */
function SetBlock({ set }: { set: NonNullable<ItemView["set"]> }) {
  return (
    <div data-testid="tooltip-set" style={{ marginTop: 6 }}>
      <div style={{ color: rarityHex("set"), fontWeight: 700 }}>{set.name}</div>
      {set.pieces.map((p, i) => (
        <div
          key={`${i}-${p.name}`}
          title={p.worn ? "Worn" : "Not worn"}
          style={{ color: p.worn ? C.text : C.faint, fontSize: 12 }}
        >
          {`${p.worn ? "✓" : "✗"} ${p.name}`}
        </div>
      ))}
      {set.bonuses.map((b) => (
        <div
          key={b.count}
          style={{
            fontSize: 12,
            color: b.active ? C.ok : C.faint,
            marginTop: 2,
          }}
        >
          {`${b.count} pieces${b.active ? " (active)" : " (inactive)"}: ${b.lines.join(", ")}`}
        </div>
      ))}
    </div>
  );
}

/** Sockets row: one glyph per socket (filled with the gem colour), then the lines of each gem. */
function SocketsBlock({ sockets }: { sockets: NonNullable<ItemView["sockets"]> }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {sockets.map((s, i) => (
          <span
            key={`${i}-${s.gem ?? "empty"}`}
            role="img"
            aria-label={s.gem ? `Socket ${i + 1}: ${s.name}` : `Socket ${i + 1}: empty`}
            style={{
              width: 12,
              height: 12,
              borderRadius: 6,
              border: `1px solid ${s.gem ? C.goldBright : C.faint}`,
              background: s.gem ? C.goldBright : "transparent",
              flex: "none",
            }}
          />
        ))}
        <span style={{ ...labelStyle, fontSize: 12 }}>{socketSummary(sockets)}</span>
      </div>
      {sockets
        .filter((s) => s.gem !== null)
        .map((s, i) => (
          <div key={`${i}-${s.name}`} style={{ fontSize: 12, marginTop: 2 }}>
            <span style={{ color: C.goldBright }}>{s.name}</span>
            {s.lines.length > 0 ? `: ${s.lines.join(", ")}` : ""}
          </div>
        ))}
    </div>
  );
}

/**
 * The body of an item tooltip: name, kind, lines, durability, sockets, set,
 * value and the comparison with the equipped item. The hover tooltip and the
 * touch item sheet (InventoryPanel) both render it.
 */
export function ItemDetails({ item, isWorn }: { item: ItemView; isWorn: boolean }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ color: rarityHex(item.rarity), fontWeight: 700, fontSize: 14 }}>
          {item.name}
        </span>
        {item.upgradeLevel && !nameShowsUpgrade(item.name, item.upgradeLevel) ? (
          <span
            data-testid="tooltip-upgrade"
            style={{ color: C.goldBright, fontWeight: 700, fontSize: 12 }}
          >{`+${fmtInt(item.upgradeLevel)}`}</span>
        ) : null}
      </div>
      <div
        style={labelStyle}
      >{`${itemKindLabel(item)} · ilvl ${fmtInt(item.ilvl)} · req ${fmtInt(item.reqLevel)}`}</div>
      <div style={{ marginTop: 6 }}>
        {item.lines.map((line, i) => (
          <div key={`${i}-${line}`}>{line}</div>
        ))}
      </div>
      {item.broken ? (
        <div style={{ color: C.danger, fontWeight: 700, marginTop: 4 }}>Broken</div>
      ) : null}
      {item.durability ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ ...labelStyle, color: item.broken ? C.danger : C.muted }}>
            {durabilityText(item.durability, item.broken === true)}
          </div>
          <ProgressBar
            pct={item.durability.max > 0 ? (item.durability.cur / item.durability.max) * 100 : 0}
            color={item.broken ? C.danger : C.ok}
            height={6}
            label="Durability"
          />
        </div>
      ) : null}
      {item.sockets && item.sockets.length > 0 ? <SocketsBlock sockets={item.sockets} /> : null}
      {item.set ? <SetBlock set={item.set} /> : null}
      <div style={{ ...labelStyle, marginTop: 6 }}>
        {`Value ${fmtInt(item.value)} gold`}
        {item.sellPrice > 0 ? ` · sells for ${fmtInt(item.sellPrice)}` : ""}
      </div>
      {item.filtered && !isWorn ? (
        <div style={{ ...labelStyle, color: C.faint, fontStyle: "italic" }}>
          Hidden by the loot filter (you can still pick it up)
        </div>
      ) : null}
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
  const isWorn = equipped.some((e) => e?.uid === item.uid);
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
      <ItemDetails item={item} isWorn={isWorn} />
    </div>
  );
}
