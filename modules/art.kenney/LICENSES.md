# Kenney art pack: licences

All art in `apps/game/public/art/kenney/` is derived from Kenney assets released under
**CC0 1.0 Universal** (public domain dedication), or drawn by `scripts/build.ts`.
Attribution is not required but is given here. Full licence text: https://creativecommons.org/publicdomain/zero/1.0/

| Source pack                 | Used for                                                                                                                                                                                                                                                                                                                          | Author | URL                                                  | Licence |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------- | ------- |
| Isometric Landscape         | `tile.grass` (`landscapeTiles_067`), `tile.stone` (`landscapeTiles_114`), `tile.dirt` (`landscapeTiles_083`), `tile.grass.dark` (recoloured grass)                                                                                                                                                                                | Kenney | https://kenney.nl/assets/isometric-tiles-landscape   | CC0-1.0 |
| Nature Kit                  | `prop.tree` (`tree_default_SW`), `prop.tree.pine`, `prop.rock`, `prop.statue`, `prop.waypoint` (recoloured obelisk), `prop.fence`, `prop.brazier`                                                                                                                                                                                 | Kenney | https://kenney.nl/assets/nature-kit                  | CC0-1.0 |
| City Kit (Suburban)         | `prop.house` (`building-type-a` preview), `prop.house.large` (`building-type-e` preview, scaled up)                                                                                                                                                                                                                               | Kenney | https://kenney.nl/assets/city-kit-suburban           | CC0-1.0 |
| Isometric Miniature Dungeon | Floors `tile.<crypt\|cave\|forge\|abyss>.floor.*` (recoloured `stone`, `dirt`, `planks`, `stoneTile`), walls `wall.*` (recoloured `stoneWall*`), props `prop.door`, `prop.stairs.*`, `prop.barrel`, `prop.crate`, `prop.pillar`, `prop.stash`; character frames `Characters/Male/Male_0..7` (8 facings) for every `unit.*` family | Kenney | https://kenney.nl/assets/isometric-miniature-dungeon | CC0-1.0 |

## Derived (recoloured, rescaled and reposed Kenney frames)

Kenney's `Characters/Male/Male_0..7` sets are the only character art in the pack. They are **one
character seen from 8 directions** (Male_0 faces up-right, then clockwise: 0 = ne, 1 = e, 2 = se, 3 = s,
4 = sw, 5 = w, 6 = nw, 7 = n in screen space). `scripts/build.ts` gives every hero, NPC and monster
per-facing clips from the matching set:

- `idle` (a 4-frame breathing squash of `Male_N_Idle0`) and `walk` (8 of the 10 `Male_N_Run*` frames)
  are Kenney's own poses.
- `attack`, `cast`, `hit` and `death` are posed procedurally from that facing's idle frame (lean,
  stretch, rotation to a lying corpse, red hit flash, cast rim glow).
- Families are told apart by recolour, scale, body reshaping (width bumps, squat, hunch, ghost fade)
  and procedural silhouette cues drawn over the body (hoods, robes, hats, crowns, horns, ears, tails,
  spider legs, spikes, wings, a mushroom cap, pustules, a bow, outlines). All of these are original.

Licence entry: `gamez procedural (recoloured and rescaled Kenney Isometric Miniature Dungeon frames)`, CC0-1.0, author Kenney.

## Procedural (drawn in `scripts/build.ts`, no source art)

`missing`, `tile.void`, `loot.gold`, `loot.potion.*` (tiers 1-4), `loot.item.*`, `fx.*` (arrow, volley, orbs, bolts,
spark, venom, portal), `unit.monster.sentry` (idle, attack, death), `unit.monster.gnawling` and
`unit.monster.webskitter` (quadrupeds and a spider drawn from scratch, with every clip), `prop.bones`, `prop.torch`,
`prop.well`, `prop.cart`, `prop.tent`. Aliases: `tile.dungeon.floor` = `tile.crypt.floor.1`,
`prop.stairs` = `prop.stairs.down`.

Licence entry: `gamez procedural (drawn by scripts/build.ts)`, CC0-1.0.

## Source files

Source PNGs are copied unchanged into `src-art/`: the Phase-0 files in the root (`grass-block.png`,
`stone-plaza.png`, `tree-default-sw.png`), and the packs in `src-art/kenney-dungeon/`,
`src-art/kenney-landscape/`, `src-art/kenney-nature/` and `src-art/kenney-city-suburban/`.
`scripts/build.ts` crops, recolours, scales and packs them into `atlas-N.png` pages (at most 2048x2048).

## Drawn creatures

`unit.monster.gnawling` (a quadruped) and `unit.monster.webskitter` (a spider) are drawn in `scripts/build.ts` from
scratch, not from Kenney frames. Their idle, walk, attack, cast, hit and death clips are generated the same way as
the other units. Licence: gamez procedural (drawn by scripts/build.ts), CC0-1.0.
