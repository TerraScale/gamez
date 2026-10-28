/**
 * Loot filter editor (panel "lootFilter", opened from Settings). Each change sends
 * classic.setLootFilter {filter: patch}. Hidden loot gets no ground label and the
 * auto controller never picks it up; sets and uniques always show.
 */
import { ACTION } from "../../../actions.ts";
import { DEFAULT_LOOT_FILTER, type LootFilter } from "../../../resources.ts";
import { ITEM_CATEGORIES, type ItemCategory, type ItemRarity } from "../../../types.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Row, Section, type SlotProps } from "../common.tsx";
import { CATEGORY_LABEL, fmtInt, RARITY_LABEL } from "../format.ts";
import { C, labelStyle } from "../styles.ts";

/** Segmented choices of a category's minimum rarity, lowest first. */
export const MIN_RARITY_CHOICES: { value: ItemRarity | "none"; label: string }[] = [
  { value: "none", label: "None" },
  { value: "normal", label: "Normal" },
  { value: "magic", label: "Magic" },
  { value: "rare", label: "Rare" },
];

/** Gold pile thresholds offered by the editor (the current value is added when it is not one of them). */
export const MIN_GOLD_CHOICES: readonly number[] = [0, 50, 100, 250, 500, 1000];

/** Options of the minimum gold select: the presets plus the current value, sorted. */
export function goldChoices(current: number): number[] {
  return [...new Set([...MIN_GOLD_CHOICES, current])].sort((a, b) => a - b);
}

/** Patch that sets one category's minimum rarity; the whole map is sent so the sim validates a complete record. */
export function minRarityPatch(
  filter: LootFilter,
  category: ItemCategory,
  value: ItemRarity | "none",
): { filter: Partial<LootFilter> } {
  return { filter: { minRarity: { ...filter.minRarity, [category]: value } } };
}

/** Patch of the gold / potion flags and the gold threshold. */
export function flagPatch(
  patch: Partial<Pick<LootFilter, "showGold" | "minGold" | "showPotions">>,
): {
  filter: Partial<LootFilter>;
} {
  return { filter: { ...patch } };
}

/** Patch that restores EVERY default (a full copy, so nothing stale survives). */
export function resetPatch(): { filter: LootFilter } {
  return {
    filter: {
      ...DEFAULT_LOOT_FILTER,
      minRarity: { ...DEFAULT_LOOT_FILTER.minRarity },
    },
  };
}

/** The sentence under the title: what is hidden, and what never is. */
export const FILTER_NOTE =
  "Hidden loot shows no label on the ground, and the auto controller never picks it up. Click it yourself to take it. Sets and uniques are always shown.";

function Segmented({
  label,
  value,
  onPick,
}: {
  label: string;
  value: ItemRarity | "none";
  onPick: (v: ItemRarity | "none") => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${label} minimum rarity`}
      style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
    >
      {MIN_RARITY_CHOICES.map((c) => (
        <Btn
          key={c.value}
          label={`${label}: show ${c.label === "None" ? "nothing" : `${c.label} and better`}`}
          pressed={value === c.value}
          minWidth={56}
          fontSize={12}
          onClick={() => onPick(c.value)}
        >
          {c.label}
        </Btn>
      ))}
    </div>
  );
}

export function LootFilterPanel({ api }: SlotProps) {
  const view = useSelect(api.hud, (s) => s.lootFilter ?? null);
  if (!view) {
    return (
      <PanelFrame api={api} id="lootFilter" title="Loot filter" width={440}>
        <p style={labelStyle}>The loot filter is not available right now.</p>
      </PanelFrame>
    );
  }
  const f = view.filter;
  const send = (patch: { filter: Partial<LootFilter> }) => api.act(ACTION.setLootFilter, patch);
  return (
    <PanelFrame
      api={api}
      id="lootFilter"
      title="Loot filter"
      width={460}
      subtitle={`Hidden on the ground here: ${fmtInt(view.hiddenOnGround)}`}
    >
      <p style={{ ...labelStyle, margin: "0 0 4px" }}>{FILTER_NOTE}</p>
      <Section title="Gear and gems">
        {ITEM_CATEGORIES.map((category) => (
          <div
            key={category}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              padding: "6px 0",
              borderBottom: `1px dashed ${C.faint}`,
            }}
          >
            <div style={{ minWidth: 84, flex: "0 0 auto", fontWeight: 600 }}>
              {CATEGORY_LABEL[category]}
            </div>
            <Segmented
              label={CATEGORY_LABEL[category]}
              value={f.minRarity[category]}
              onPick={(v) => send(minRarityPatch(f, category, v))}
            />
          </div>
        ))}
        <p style={{ ...labelStyle, marginTop: 6 }}>
          {`Sets and uniques (${RARITY_LABEL.set}, ${RARITY_LABEL.unique}) always show, whatever the setting above.`}
        </p>
      </Section>
      <Section title="Gold and potions">
        <Row>
          <Btn
            label="Show gold piles"
            pressed={f.showGold}
            onClick={() => send(flagPatch({ showGold: !f.showGold }))}
          >
            Gold piles
          </Btn>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={labelStyle}>at least</span>
            <select
              aria-label="Smallest gold pile shown"
              value={f.minGold}
              disabled={!f.showGold}
              onChange={(e) => send(flagPatch({ minGold: Number(e.target.value) }))}
            >
              {goldChoices(f.minGold).map((g) => (
                <option key={g} value={g}>
                  {`${fmtInt(g)} g`}
                </option>
              ))}
            </select>
          </label>
        </Row>
        <Row>
          <Btn
            label="Show potions"
            pressed={f.showPotions}
            onClick={() => send(flagPatch({ showPotions: !f.showPotions }))}
          >
            Potions
          </Btn>
        </Row>
      </Section>
      <Section title="Reset">
        <Btn
          label="Reset the loot filter to defaults"
          onClick={() => api.act(ACTION.setLootFilter, resetPatch())}
        >
          Reset to defaults
        </Btn>
      </Section>
    </PanelFrame>
  );
}
