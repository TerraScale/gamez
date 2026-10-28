/**
 * Inventory: paper doll (9 equip slots), the bag grid by footprint, and an item
 * menu. Click a bag item to equip it, long-press or right-click for the menu,
 * move by "Move" then a cell. Click an equipped slot to unequip. On touch a
 * tap opens the item sheet (full details and actions) and a second tap on the
 * same item equips it, so nothing is equipped before its stats were seen.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ACTION } from "../../../actions.ts";
import type { EquipSlot } from "../../../types.ts";
import type { ItemView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, useCompact, type SlotProps } from "../common.tsx";
import {
  BAG_CELL_PX,
  EQUIP_LABEL,
  fmtInt,
  gridOccupancy,
  pluralize,
  RARITY_LABEL,
  rarityHex,
} from "../format.ts";
import { ItemIcon } from "../icons.tsx";
import { C, labelStyle } from "../styles.ts";
import { gemTierOf } from "../../describe.ts";
import { useSelectedStashTab } from "./StashPanel.tsx";
import { ItemDetails } from "../widgets/Tooltip.tsx";

/**
 * Marks on a bag cell: socket dots (top left, filled when a gem sits in it), the
 * gem tier (top right), and a durability tick along the bottom while the item is worn.
 */
export function CellMarks({ item }: { item: ItemView }) {
  const sockets = item.sockets ?? [];
  const tier = item.category === "gem" ? gemTierOf(item.name) : 0;
  const dur = item.durability ?? null;
  const worn = dur !== null && dur.max > 0 && (item.broken === true || dur.cur < dur.max);
  const pct = worn && dur ? Math.max(0, Math.min(100, (dur.cur / dur.max) * 100)) : null;
  return (
    <>
      {sockets.length > 0 ? (
        <span
          aria-hidden="true"
          style={{ position: "absolute", left: 3, top: 3, display: "flex", gap: 2 }}
        >
          {sockets.map((s, i) => (
            <span
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                border: `1px solid ${C.goldBright}`,
                background: s.gem ? C.goldBright : "transparent",
              }}
            />
          ))}
        </span>
      ) : null}
      {tier > 0 ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 3,
            top: 2,
            fontSize: 11,
            fontWeight: 700,
            color: C.goldBright,
          }}
        >{`T${tier}`}</span>
      ) : null}
      {pct !== null ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 4,
            right: 4,
            bottom: 3,
            height: 3,
            borderRadius: 2,
            background: "rgba(0, 0, 0, 0.6)",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${pct}%`,
              background: item.broken ? C.danger : pct <= 10 ? "#e0a040" : C.ok,
            }}
          />
        </span>
      ) : null}
    </>
  );
}

/** Paper doll layout: null = empty cell. */
export const DOLL: (EquipSlot | null)[][] = [
  [null, "helm", "amulet"],
  ["weapon", "armor", "offhand"],
  ["ring1", "gloves", "ring2"],
  [null, "boots", null],
];

export const LONG_PRESS_MS = 450;

/**
 * What a tap or click on a bag item does: finish or cancel a move, open the
 * item sheet (touch, first tap) or equip (mouse, pen, keyboard, or a second
 * touch tap on the item whose sheet is open).
 */
export function bagTapAction(o: {
  moving: boolean;
  pointerType: string;
  sheetOpen: boolean;
}): "move" | "details" | "equip" {
  if (o.moving) return "move";
  if (o.pointerType === "touch" && !o.sheetOpen) return "details";
  return "equip";
}

interface BagItemProps {
  item: ItemView;
  x: number;
  y: number;
  cell: number;
  /** Gap between the item box and its cell edge (0 on compact layouts, so the box is the full cell). */
  inset: number;
  selected: boolean;
  /** `pointerType` of the press that led to the click ("" for keyboard clicks). */
  onPick: (item: ItemView, pointerType: string) => void;
  onMenu: (uid: number) => void;
  onHover: (uid: number, x: number, y: number) => void;
  onLeave: () => void;
}

function BagItem({
  item,
  x,
  y,
  cell,
  inset,
  selected,
  onPick,
  onMenu,
  onHover,
  onLeave,
}: BagItemProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const pointer = useRef("");
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const color = rarityHex(item.rarity);
  const broken = item.broken === true;
  const extras = [
    broken ? "broken" : null,
    item.sockets && item.sockets.length > 0 ? `${item.sockets.length} sockets` : null,
  ].filter((t): t is string => t !== null);
  return (
    <button
      type="button"
      aria-label={`${item.name}, ${RARITY_LABEL[item.rarity]}, ${item.w} by ${item.h}${extras.map((t) => `, ${t}`).join("")}`}
      title={item.name}
      onClick={() => {
        const type = pointer.current;
        pointer.current = "";
        if (fired.current) {
          fired.current = false;
          return;
        }
        onPick(item, type);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        clear();
        onMenu(item.uid);
      }}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        pointer.current = e.pointerType;
        fired.current = false;
        clear();
        onLeave();
        timer.current = setTimeout(() => {
          fired.current = true;
          onMenu(item.uid);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerEnter={(e: PointerEvent<HTMLButtonElement>) => {
        // A touch has no hover: the tap opens the item sheet instead.
        if (e.pointerType !== "touch") onHover(item.uid, e.clientX, e.clientY);
      }}
      onPointerLeave={() => {
        clear();
        onLeave();
      }}
      style={{
        position: "absolute",
        zIndex: 1,
        left: x * cell + inset,
        top: y * cell + inset,
        width: item.w * cell - 2 * inset,
        height: item.h * cell - 2 * inset,
        padding: 0,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: broken ? "rgba(224, 102, 79, 0.22)" : "rgba(0, 0, 0, 0.42)",
        border: `2px solid ${selected ? C.borderStrong : broken ? C.danger : color}`,
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
      <CellMarks item={item} />
    </button>
  );
}

export function InventoryPanel({ api }: SlotProps) {
  const inv = useSelect(api.hud, (s) => s.inventory);
  const equipment = useSelect(api.hud, (s) => s.equipment);
  const vendor = useSelect(api.hud, (s) =>
    s.vendor ? { npc: s.vendor.npc, role: s.vendor.role } : null,
  );
  const stashOpen = useSelect(api.ui, (u) => u.panels.includes("stash"));
  const stashTab = useSelectedStashTab();
  const gold = useSelect(api.hud, (s) => (s.hero ? s.hero.gold : 0));
  const compact = useCompact(api);
  const [moving, setMoving] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // The sheet sits under the bag: on a phone it can open below the fold.
  useEffect(() => {
    if (menu === null) return;
    const el = sheetRef.current as { scrollIntoView?: (o: object) => void } | null;
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [menu]);

  // Closing the panel (Escape, closeAll) unmounts it without a pointer-leave, so the
  // item tooltip would stay on screen. Clear it on unmount.
  useEffect(() => () => api.setHover(null), [api]);

  // Cells keep the 44 px touch target on every layout; on compact screens the
  // bag card scrolls sideways instead of shrinking the cells.
  const cell = BAG_CELL_PX;
  const inset = compact ? 0 : 2;
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

  // While the item menu is open the tooltip stays away (it would cover the menu's title).
  const hover = (uid: number, x: number, y: number) => {
    if (menu === null) api.setHover({ uid, x, y });
  };
  const leave = () => api.setHover(null);
  const openMenu = (uid: number) => {
    api.setHover(null);
    setMenu(uid);
  };

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
            left: x * cell + inset,
            top: y * cell + inset,
            width: cell - 2 * inset,
            height: cell - 2 * inset,
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
      subtitle={`${fmtInt(gold)} gold · ${pluralize(inv.items.length, "item")}`}
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
                    border: `1px solid ${item ? (item.broken ? C.danger : rarityHex(item.rarity)) : C.border}`,
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
                  inset={inset}
                  selected={p.item.uid === moving}
                  onPick={(item, pointerType) => {
                    const what = bagTapAction({
                      moving: moving !== null,
                      pointerType,
                      sheetOpen: menu === item.uid,
                    });
                    if (what === "move") {
                      if (item.uid === moving) setMoving(null);
                      else place(p.x, p.y);
                    } else if (what === "details") {
                      openMenu(item.uid);
                    } else {
                      api.act(ACTION.equip, { uid: item.uid, slot: null });
                      if (menu === item.uid) setMenu(null);
                    }
                  }}
                  onMenu={openMenu}
                  onHover={hover}
                  onLeave={leave}
                />
              ))}
            </div>
          </div>
          <div style={{ ...labelStyle, marginTop: 6 }}>
            {compact
              ? `${pluralize(freeCells, "free cell")} · tap an item for its details, tap it again to equip · swipe the bag sideways to see every cell`
              : `${pluralize(freeCells, "free cell")} · click an item to equip it, right-click or hold for actions`}
          </div>
          {menuItem ? (
            <div
              ref={sheetRef}
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
              <ItemDetails item={menuItem} isWorn={false} />
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
                      api.act(ACTION.stashPut, { uid: menuItem.uid, tab: stashTab });
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
