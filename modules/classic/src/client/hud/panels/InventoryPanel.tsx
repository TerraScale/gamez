/**
 * Inventory: paper doll (9 equip slots), the bag grid by footprint, and an item
 * menu. Click a bag item to equip it, long-press or right-click for the menu,
 * move by "Move" then a cell. Click an equipped slot to unequip.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ACTION } from "../../../actions.ts";
import type { EquipSlot } from "../../../types.ts";
import type { ItemView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, useCompact, type SlotProps } from "../common.tsx";
import {
  bagCellSize,
  EQUIP_LABEL,
  fmtInt,
  gridOccupancy,
  RARITY_LABEL,
  rarityHex,
} from "../format.ts";
import { ItemIcon } from "../icons.tsx";
import { C, labelStyle } from "../styles.ts";

/** Paper doll layout: null = empty cell. */
export const DOLL: (EquipSlot | null)[][] = [
  [null, "helm", "amulet"],
  ["weapon", "armor", "offhand"],
  ["ring1", "gloves", "ring2"],
  [null, "boots", null],
];

export const LONG_PRESS_MS = 450;

interface BagItemProps {
  item: ItemView;
  x: number;
  y: number;
  cell: number;
  selected: boolean;
  onPick: (item: ItemView) => void;
  onMenu: (uid: number) => void;
  onHover: (uid: number, x: number, y: number) => void;
  onLeave: () => void;
}

function BagItem({ item, x, y, cell, selected, onPick, onMenu, onHover, onLeave }: BagItemProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const color = rarityHex(item.rarity);
  return (
    <button
      type="button"
      aria-label={`${item.name}, ${RARITY_LABEL[item.rarity]}, ${item.w} by ${item.h}`}
      title={item.name}
      onClick={() => {
        if (fired.current) {
          fired.current = false;
          return;
        }
        onPick(item);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        clear();
        onMenu(item.uid);
      }}
      onPointerDown={() => {
        fired.current = false;
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          onMenu(item.uid);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerEnter={(e: PointerEvent<HTMLButtonElement>) =>
        onHover(item.uid, e.clientX, e.clientY)
      }
      onPointerLeave={() => {
        clear();
        onLeave();
      }}
      style={{
        position: "absolute",
        zIndex: 1,
        left: x * cell + 2,
        top: y * cell + 2,
        width: item.w * cell - 4,
        height: item.h * cell - 4,
        padding: 0,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.42)",
        border: `2px solid ${selected ? C.borderStrong : color}`,
        borderRadius: 6,
        pointerEvents: "auto",
        color: C.text,
      }}
    >
      <ItemIcon
        category={item.category}
        color={color}
        size={Math.min(item.w, item.h) * cell - 14}
      />
    </button>
  );
}

/** Window width in CSS px, updated on resize (375 when there is no window, e.g. SSR tests). */
function useViewportWidth(): number {
  const read = (): number => (typeof window === "undefined" ? 375 : window.innerWidth);
  const [w, setW] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = (): void => setW(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export function InventoryPanel({ api }: SlotProps) {
  const inv = useSelect(api.hud, (s) => s.inventory);
  const equipment = useSelect(api.hud, (s) => s.equipment);
  const vendor = useSelect(api.hud, (s) =>
    s.vendor ? { npc: s.vendor.npc, role: s.vendor.role } : null,
  );
  const stashOpen = useSelect(api.ui, (u) => u.panels.includes("stash"));
  const gold = useSelect(api.hud, (s) => (s.hero ? s.hero.gold : 0));
  const compact = useCompact(api);
  const [moving, setMoving] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);

  const viewport = useViewportWidth();
  const cell = bagCellSize(compact, viewport, inv.cols);
  const occupied = useMemo(
    () =>
      gridOccupancy(
        inv.cols,
        inv.rows,
        inv.items.map((p) => ({ x: p.x, y: p.y, w: p.item.w, h: p.item.h })),
      ),
    [inv],
  );
  const freeCells = occupied.filter((o) => !o).length;
  const menuItem = inv.items.find((p) => p.item.uid === menu)?.item ?? null;
  const movingItem = inv.items.find((p) => p.item.uid === moving)?.item ?? null;

  const hover = (uid: number, x: number, y: number) => api.setHover({ uid, x, y });
  const leave = () => api.setHover(null);

  const place = (x: number, y: number) => {
    if (moving === null) return;
    api.act(ACTION.moveItem, { uid: moving, x, y });
    setMoving(null);
  };

  const cells = [];
  for (let y = 0; y < inv.rows; y++) {
    for (let x = 0; x < inv.cols; x++) {
      if (occupied[y * inv.cols + x]) continue;
      cells.push(
        <button
          key={`${x},${y}`}
          type="button"
          disabled={moving === null}
          aria-label={`Empty cell ${x + 1}, ${y + 1}`}
          onClick={() => place(x, y)}
          style={{
            position: "absolute",
            left: x * cell + 2,
            top: y * cell + 2,
            width: cell - 4,
            height: cell - 4,
            padding: 0,
            borderRadius: 4,
            background: moving === null ? "rgba(255, 240, 210, 0.03)" : "rgba(243, 210, 122, 0.12)",
            border: `1px dashed ${moving === null ? C.faint : C.gold}`,
            cursor: moving === null ? "default" : "pointer",
          }}
        />,
      );
    }
  }

  return (
    <PanelFrame
      api={api}
      id="inventory"
      title="Inventory"
      width={compact ? 380 : 700}
      subtitle={`${fmtInt(gold)} gold · ${inv.items.length} items`}
    >
      <div
        style={{
          display: "flex",
          flexDirection: compact ? "column" : "row",
          gap: 16,
          alignItems: "flex-start",
        }}
      >
        <div
          aria-label="Equipment"
          style={{ display: "grid", gridTemplateColumns: "repeat(3, 62px)", gap: 6, flex: "none" }}
        >
          {DOLL.flatMap((row, ry) =>
            row.map((slot, cx) => {
              if (slot === null) return <div key={`${ry}-${cx}`} />;
              const item = equipment[slot] ?? null;
              return (
                <button
                  key={slot}
                  type="button"
                  aria-label={`${EQUIP_LABEL[slot]} slot: ${item ? item.name : "empty"}`}
                  onClick={() => {
                    if (item) api.act(ACTION.unequip, { slot });
                  }}
                  onPointerEnter={(e) => item && hover(item.uid, e.clientX, e.clientY)}
                  onPointerLeave={leave}
                  style={{
                    pointerEvents: "auto",
                    width: 62,
                    height: 62,
                    padding: 2,
                    borderRadius: 8,
                    cursor: item ? "pointer" : "default",
                    background: "rgba(0, 0, 0, 0.4)",
                    border: `1px solid ${item ? rarityHex(item.rarity) : C.border}`,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    color: C.text,
                    font: "inherit",
                  }}
                >
                  {item ? (
                    <ItemIcon category={item.category} color={rarityHex(item.rarity)} size={34} />
                  ) : null}
                  <span style={{ ...labelStyle, fontSize: 10, lineHeight: 1 }}>
                    {EQUIP_LABEL[slot]}
                  </span>
                </button>
              );
            }),
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1, width: "100%" }}>
          {moving !== null ? (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 8,
                color: C.goldBright,
              }}
            >
              <span>{`Moving ${movingItem?.name ?? "item"}: click a free cell or another item.`}</span>
              <Btn height={40} fontSize={12} label="Cancel move" onClick={() => setMoving(null)}>
                Cancel
              </Btn>
            </div>
          ) : null}
          <div style={{ overflowX: "auto", paddingBottom: 4 }}>
            <div
              aria-label="Bag grid"
              style={{
                position: "relative",
                width: inv.cols * cell,
                height: inv.rows * cell,
                flex: "none",
              }}
            >
              {cells}
              {inv.items.map((p) => (
                <BagItem
                  key={p.item.uid}
                  item={p.item}
                  x={p.x}
                  y={p.y}
                  cell={cell}
                  selected={p.item.uid === moving}
                  onPick={(item) => {
                    if (moving !== null) {
                      if (item.uid === moving) setMoving(null);
                      else place(p.x, p.y);
                      return;
                    }
                    api.act(ACTION.equip, { uid: item.uid, slot: null });
                  }}
                  onMenu={(uid) => setMenu(uid)}
                  onHover={hover}
                  onLeave={leave}
                />
              ))}
            </div>
          </div>
          <div
            style={{ ...labelStyle, marginTop: 6 }}
          >{`${fmtInt(freeCells)} free cells · click an item to equip it, right-click or hold for actions`}</div>
          {menuItem ? (
            <div
              role="menu"
              aria-label="Item actions"
              style={{
                marginTop: 10,
                padding: 10,
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: "rgba(255, 240, 210, 0.05)",
              }}
            >
              <div style={{ color: rarityHex(menuItem.rarity), fontWeight: 700 }}>
                {menuItem.name}
              </div>
              <div style={labelStyle}>{menuItem.lines.join(" · ")}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <Btn
                  onClick={() => {
                    api.act(ACTION.equip, { uid: menuItem.uid, slot: null });
                    setMenu(null);
                  }}
                >
                  Equip
                </Btn>
                <Btn
                  onClick={() => {
                    setMoving(menuItem.uid);
                    setMenu(null);
                  }}
                >
                  Move
                </Btn>
                <Btn
                  onClick={() => {
                    api.act(ACTION.dropItem, { uid: menuItem.uid });
                    setMenu(null);
                  }}
                >
                  Drop
                </Btn>
                {vendor?.role === "junk" ? (
                  <Btn
                    onClick={() => {
                      api.act(ACTION.sell, { npc: vendor.npc, uid: menuItem.uid });
                      setMenu(null);
                    }}
                  >
                    {`Sell${menuItem.sellPrice > 0 ? ` (${fmtInt(menuItem.sellPrice)})` : ""}`}
                  </Btn>
                ) : null}
                {stashOpen ? (
                  <Btn
                    onClick={() => {
                      api.act(ACTION.stashPut, { uid: menuItem.uid });
                      setMenu(null);
                    }}
                  >
                    Stash
                  </Btn>
                ) : null}
                <Btn onClick={() => setMenu(null)}>Close</Btn>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </PanelFrame>
  );
}
