/**
 * classic.items.drops (post 100, OWNER: T5 / T-items): loot for hero kills
 * (design §11.3; wave A: dropped sockets and gems, wave-A.md §5.2). Reads Bus.deaths only; creates Loot entities on walkable tiles
 * around the death point (spiral search, radius <= 3).
 */
import type { Entity, FrozenRegistry, SystemDef, World } from "@gamez/kernel";
import { AreaTag, Loot, Pos } from "../components.ts";
import { emit } from "../events.ts";
import { pct, tileCenter, toTile } from "../fixed.ts";
import { busOf, type DeathRecord } from "../bus.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth } from "../resources.ts";
import { getMap, walkableAt, type ClassicMap } from "../world/maps.ts";
import {
  KIND,
  type ItemBaseProto,
  type ItemInstance,
  type ItemRarity,
  type MonsterRarity,
} from "../types.ts";
import { balanceOf, heroFind, percentRoll } from "./common.ts";
import { gemBaseFor, gemTierFor, makeGemItem, rollDropSockets, rollItem } from "./generate.ts";

/** Potion base whose tier is closest to ceil(depth / 4) for the given kind (ties: lower tier). */
export function potionFor(
  reg: FrozenRegistry,
  kind: "life" | "mana",
  depth: number,
): string | undefined {
  const target = Math.ceil(Math.max(1, depth) / 4);
  let best: string | undefined;
  let bestDiff = Infinity;
  let bestTier = Infinity;
  for (const [id, b] of reg.all<ItemBaseProto>(KIND.itemBase)) {
    const p = b.potion;
    if (!p || p.kind !== kind) continue;
    const diff = Math.abs(p.tier - target);
    if (diff < bestDiff || (diff === bestDiff && p.tier < bestTier)) {
      best = id;
      bestDiff = diff;
      bestTier = p.tier;
    }
  }
  return best;
}

/** Tile key for the loot occupancy set. */
function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** First free walkable tile around (tx, ty) in ring order, radius <= 3; falls back to the centre tile. */
export function freeSpot(
  map: ClassicMap,
  tx: number,
  ty: number,
  taken: Set<string>,
): { x: number; y: number } {
  for (let r = 0; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (!walkableAt(map, x, y) || taken.has(tileKey(x, y))) continue;
        return { x, y };
      }
    }
  }
  return { x: tx, y: ty };
}

interface Drop {
  kind: "item" | "gold" | "potion";
  item?: ItemInstance;
  gold?: number;
  potion?: string;
}

function dropName(d: Drop): { name: string; rarity: ItemRarity } {
  if (d.kind === "item" && d.item) return { name: d.item.name, rarity: d.item.rarity };
  if (d.kind === "gold") return { name: `${d.gold ?? 0} gold`, rarity: "normal" };
  return { name: d.potion ?? "potion", rarity: "normal" };
}

export const dropsSystem: SystemDef = {
  ...SYSTEM.itemsDrops,
  run(world, ctx) {
    const bus = busOf(world);
    if (bus.deaths.length === 0) return;
    const reg = ctx.registry;
    const bal = balanceOf(reg);
    const rng = ctx.rng;
    const find = heroFind(world);
    // Occupied loot tiles of the current area; grows as drops are placed.
    const taken = lootTiles(world, currentDepth(world));

    for (const d of bus.deaths) {
      if (!isLootDeath(d)) continue;
      const table = bal.drops[d.rarity];
      if (!table) continue;
      const map = getMap(world, reg, d.depth);
      const place = (drop: Drop): void => {
        const spot = freeSpot(map, toTile(d.x), toTile(d.y), taken);
        const x = tileCenter(spot.x);
        const y = tileCenter(spot.y);
        taken.add(tileKey(spot.x, spot.y));
        const e: Entity = world.create();
        world.add(e, Loot, {
          kind: drop.kind,
          item: drop.item ?? null,
          gold: drop.gold ?? 0,
          potion: drop.potion ?? "",
          droppedAt: ctx.tick,
        });
        world.add(e, Pos, { x, y });
        world.add(e, AreaTag, { depth: d.depth });
        const n = dropName(drop);
        emit(ctx, {
          type: "classic.loot.dropped",
          entity: e,
          kind: drop.kind,
          name: n.name,
          rarity: n.rarity,
          x,
          y,
        });
      };

      // Items: boss kills always give at least two rare or better.
      if (percentRoll(rng, table.item)) {
        const count = rng.int(table.items[0], table.items[1]);
        for (let i = 0; i < count; i++) {
          const item = rollItem(world, ctx, {
            ilvl: d.level,
            rarity: null,
            magicFind: find.magicFind,
            minRarity: d.rarity === "boss" && i < 2 ? "rare" : "normal",
          });
          if (!item) continue;
          rollDropSockets(rng, reg, bal, item);
          place({ kind: "item", item });
        }
      }
      if (percentRoll(rng, table.gold)) {
        const raw = rng.int(bal.goldPerLevel[0], bal.goldPerLevel[1]) * Math.max(1, d.level);
        const gold = Math.max(1, pct(raw, 100 + find.goldFind));
        place({ kind: "gold", gold });
      }
      if (percentRoll(rng, table.potion)) {
        const kind = percentRoll(rng, 75) ? "life" : "mana";
        const potion = potionFor(reg, kind, d.depth);
        if (potion) place({ kind: "potion", potion });
      }
      // Wave A: gems (BalanceProto.gemDrops by monster rarity, tier by monster level).
      const gemPct = bal.gemDrops?.[d.rarity] ?? 0;
      if (gemPct > 0 && percentRoll(rng, gemPct)) {
        const gem = gemBaseFor(rng, reg, gemTierFor(d.level));
        if (gem) place({ kind: "item", item: makeGemItem(world, reg, gem) });
      }
    }
  },
};

/** Monster deaths credited to the hero (not hero summons, not the hero). */
function isLootDeath(d: DeathRecord): d is DeathRecord & { rarity: MonsterRarity } {
  return d.creditTeam === "hero" && !d.isHero && d.rarity !== "hero" && d.rarity !== "summon";
}

/** Occupied loot tiles of a depth. */
function lootTiles(world: World, depth: number): Set<string> {
  const taken = new Set<string>();
  for (const e of world.query(Loot, Pos, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth) continue;
    const p = world.read(e, Pos);
    taken.add(tileKey(toTile(p.x), toTile(p.y)));
  }
  return taken;
}
