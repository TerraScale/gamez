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

## Wave A additions (all procedural, drawn in `scripts/build.ts`)

No new external asset was used in wave A. The Kenney Particle Pack page
(https://kenney.nl/assets/particle-pack) was checked, but its download link is
gated behind JavaScript and no archive could be fetched without it, so every
particle texture below is drawn in code instead. Nothing was downloaded to
`/tmp/gamez-downloads/waveA-art/` beyond that page, and nothing was executed.
All additions are original designs under CC0-1.0 (gamez procedural, drawn by
`scripts/build.ts`).

- **Units.** Every unit now has `cast` and `hit` clips for all 8 facings (NPCs included),
  and NPCs have the full clip set (their attack and death clips are never played in
  game). `hit` is a 3-frame recoil and squash under a brief white flash. Classes
  and NPCs are told apart by drawn silhouettes on the shared Kenney body: warrior (plate,
  great helm, shield, sword), rogue (green cloak, hood, bow, quiver), sorcerer (robe, hat,
  staff), healer (robe, staff), smith (apron, hammer, beard), alchemist (hat, satchel,
  flask), junk buyer (hunched, sack), Captain Hale (plate, red cloak, gold pauldrons) and
  the new `unit.npc.gambler` (tall hat, long dark coat, dice).
- **Monsters.** `unit.monster.guardian_maw` (a huge toothed brute with a maw across its
  chest) and `unit.monster.guardian_choir` (a hooded ember robe with two companions
  drifting either side, ghost-faded legs), each with every clip and facing like the bosses.
- **Effects.** Every `EFFECT_TABLE` id and the wave A effects have a one-shot
  `<id>.burst` animation (6 to 10 frames, 16 to 24 fps, centre anchor, 128 px frames
  where 64 px is one tile of radius) and a still sprite `<id>` (the burst's middle frame).
  The projectile stills `fx.piercing_shot`, `fx.night_volley` and `fx.glacial_spike`
  point right like `fx.arrow`.
- **Particles.** `fx.particle.<style>` for spark, ember, frost, poison, arcane, holy,
  shadow, blood, dust and gold (24 px soft dots with a core and a halo).
- **Props and loot.** `prop.rift.obelisk` (a tall dark obelisk with a violet core),
  `fx.rift.exit` (a looping violet-teal portal, 8 frames) and `loot.item.gem` (a faceted
  cyan gem).
- **Palette trim.** Visible channels are rounded to multiples of 4 (at most 2 levels off)
  and fully transparent pixels get no colour; alpha in burst frames has 24 levels. This keeps
  the atlas PNGs about 15 % above the pre-wave-A size (limit 20 %).
