/**
 * Rift level map (classic.world, wave A; docs/design/wave-A.md §7). PURE: a
 * function of (registry, worldSeed, depth) like every area. The level is the
 * dungeon generator with the RiftProto shape: RiftProto.size square, rooms and
 * room sizes from the proto, theme RiftProto.themes[level % n], no stairs, no
 * waypoint and no boss spot. Rift depths come from rules.riftDepth.
 */
import type { FrozenRegistry } from "@gamez/kernel";
import { riftLevelOf } from "../rules.ts";
import { KIND, RIFT_ID, type RiftProto, type ThemeProto } from "../types.ts";
import { buildDungeon, type LevelShape } from "./dungeon.ts";
import { DEFAULT_LEVEL, pickTheme, type ThemePick } from "./common.ts";
import type { ClassicMap } from "./maps.ts";

/** Used when no RiftProto is registered (test content without rifts). */
const FALLBACK_RIFT = {
  size: DEFAULT_LEVEL.width,
  rooms: DEFAULT_LEVEL.rooms,
  roomSize: DEFAULT_LEVEL.roomSize,
};

/** The RiftProto of the registry, or null. */
export function riftProtoOf(registry: FrozenRegistry): Readonly<RiftProto> | null {
  return registry.get<RiftProto>(KIND.rift, RIFT_ID) ?? null;
}

/** Theme of a rift level: RiftProto.themes[level % n], else the depth's dungeon theme. */
function riftTheme(
  registry: FrozenRegistry,
  rift: Readonly<RiftProto> | null,
  level: number,
  depth: number,
): ThemePick {
  const list = rift?.themes ?? [];
  if (list.length === 0) return pickTheme(registry, depth);
  const id = list[level % list.length] ?? list[0] ?? "";
  const proto = registry.get<ThemeProto>(KIND.theme, id);
  if (!proto) return pickTheme(registry, depth);
  return { id, name: proto.name, proto };
}

/** Generates the rift level `depth` (rules.isRiftDepth). */
export function buildRiftLevel(
  registry: FrozenRegistry,
  worldSeed: number,
  depth: number,
): ClassicMap {
  const rift = riftProtoOf(registry);
  const level = riftLevelOf(depth);
  const size = rift?.size ?? FALLBACK_RIFT.size;
  const shape: LevelShape = {
    width: size,
    height: size,
    rooms: rift?.rooms ?? FALLBACK_RIFT.rooms,
    roomSize: rift?.roomSize ?? FALLBACK_RIFT.roomSize,
    theme: riftTheme(registry, rift, level, depth),
    name: "",
    rift: true,
  };
  shape.name = `${shape.theme.name} - Rift ${level}`;
  return buildDungeon(registry, worldSeed, depth, shape);
}
