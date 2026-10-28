# Kenney art pack: licences

All art in `apps/game/public/art/kenney/` is derived from Kenney assets released under
**CC0 1.0 Universal** (public domain dedication), or drawn by `scripts/build.ts`.
Attribution is not required but is given here. Full licence text: https://creativecommons.org/publicdomain/zero/1.0/

| Source pack                 | Used for                                                                                                                                                                                                                                                                                                              | Author | URL                                                  | Licence |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------- | ------- |
| Isometric Landscape         | `tile.grass` (`landscapeTiles_067`), `tile.stone` (`landscapeTiles_114`), `tile.dirt` (`landscapeTiles_083`), `tile.grass.dark` (recoloured grass)                                                                                                                                                                    | Kenney | https://kenney.nl/assets/isometric-tiles-landscape   | CC0-1.0 |
| Nature Kit                  | `prop.tree` (`tree_default_SW`), `prop.tree.pine`, `prop.rock`, `prop.statue`, `prop.waypoint` (recoloured obelisk), `prop.fence`, `prop.brazier`                                                                                                                                                                     | Kenney | https://kenney.nl/assets/nature-kit                  | CC0-1.0 |
| City Kit (Suburban)         | `prop.house` (`building-type-a` preview), `prop.house.large` (`building-type-e` preview, scaled up)                                                                                                                                                                                                                   | Kenney | https://kenney.nl/assets/city-kit-suburban           | CC0-1.0 |
| Isometric Miniature Dungeon | Floors `tile.<crypt\|cave\|forge\|abyss>.floor.*` (recoloured `stone`, `dirt`, `planks`, `stoneTile`), walls `wall.*` (recoloured `stoneWall*`), props `prop.door`, `prop.stairs.*`, `prop.barrel`, `prop.crate`, `prop.pillar`, `prop.stash`; character frames `Characters/Male/Male_0..7` for every `unit.*` family | Kenney | https://kenney.nl/assets/isometric-miniature-dungeon | CC0-1.0 |

## Derived (recoloured, rescaled or leaned Kenney frames)

Kenney's `Male_0..7` character sets are the only character art in the pack. Every hero class, NPC and
monster is a recolour (hue, saturation, lightness or tint), a rescale or a lean of one of these sets
in `scripts/build.ts`, so the families look distinct. Attack frames are leaned idle frames and death
frames are squashed, faded idle frames. Only the idle and walk (run) frames are Kenney's own motion.

Licence entry: `gamez procedural (recoloured and rescaled Kenney Isometric Miniature Dungeon frames)`, CC0-1.0, author Kenney.

## Procedural (drawn in `scripts/build.ts`, no source art)

`missing`, `tile.void`, `loot.gold`, `loot.potion.*`, `loot.item.*`, `fx.*` (arrow, orbs, bolts, spark, venom,
portal), `unit.monster.sentry`, `prop.bones`, `prop.torch`, `prop.well`, `prop.cart`, `prop.tent`.

Licence entry: `gamez procedural (drawn by scripts/build.ts)`, CC0-1.0.

## Source files

Source PNGs are copied unchanged into `src-art/`: the Phase-0 files in the root (`grass-block.png`,
`stone-plaza.png`, `tree-default-sw.png`, `hero-*.png`), and the packs in `src-art/kenney-dungeon/`,
`src-art/kenney-landscape/`, `src-art/kenney-nature/` and `src-art/kenney-city-suburban/`.
`scripts/build.ts` crops, recolours, scales and packs them into `atlas-N.png` pages (at most 2048x2048).
