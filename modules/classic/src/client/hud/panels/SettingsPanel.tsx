/** Settings: display toggles, zoom, auto-config editor, new game and exit (panel "settings"). */
import { useState } from "react";
import { ACTION } from "../../../actions.ts";
import { ITEM_RARITIES, type ItemRarity } from "../../../types.ts";
import type { AutoConfig } from "../../../resources.ts";
import type { Settings } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Row, Section, type SlotProps } from "../common.tsx";
import { C, labelStyle } from "../styles.ts";

type BoolSetting = "showDamageNumbers" | "showLootLabels" | "showMinimap" | "lighting" | "showPerf";

const FLAGS: { key: BoolSetting; label: string }[] = [
  { key: "showDamageNumbers", label: "Damage numbers" },
  { key: "showLootLabels", label: "Loot labels" },
  { key: "showMinimap", label: "Minimap (M)" },
  { key: "lighting", label: "Lighting" },
  { key: "showPerf", label: "Performance overlay" },
];

type NumberField =
  | "lifePotionPct"
  | "manaPotionPct"
  | "retreatPct"
  | "explorePct"
  | "manaReservePct"
  | "maxDepth";
const NUMBER_FIELDS: { key: NumberField; label: string; min: number; max: number }[] = [
  { key: "lifePotionPct", label: "Drink a life potion below (% life)", min: 1, max: 99 },
  { key: "manaPotionPct", label: "Drink a mana potion below (% mana)", min: 0, max: 99 },
  { key: "retreatPct", label: "Return to town below (% life, no potions)", min: 0, max: 99 },
  { key: "manaReservePct", label: "Keep mana in reserve (%)", min: 0, max: 90 },
  { key: "explorePct", label: "Explore a level until (% explored)", min: 10, max: 100 },
  { key: "maxDepth", label: "Do not descend below depth (0 = no limit)", min: 0, max: 200 },
];

type BoolField =
  | "autoEquip"
  | "autoAllocate"
  | "autoDescend"
  | "buyPotions"
  | "pickupGold"
  | "pickupPotions";
const BOOL_FIELDS: { key: BoolField; label: string }[] = [
  { key: "autoEquip", label: "Equip upgrades" },
  { key: "autoAllocate", label: "Spend attribute points" },
  { key: "autoDescend", label: "Descend when the level is explored" },
  { key: "buyPotions", label: "Buy potions in town" },
  { key: "pickupGold", label: "Pick up gold" },
  { key: "pickupPotions", label: "Pick up potions" },
];

function patch<K extends keyof AutoConfig>(
  draft: AutoConfig,
  key: K,
  value: AutoConfig[K],
): AutoConfig {
  return { ...draft, [key]: value };
}

function RaritySelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ItemRarity;
  onChange: (r: ItemRarity) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        minHeight: 44,
      }}
    >
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as ItemRarity)}
      >
        {ITEM_RARITIES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, cursor: "pointer" }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 24, height: 24, flex: "none", margin: 0 }}
      />
      <span>{label}</span>
    </label>
  );
}

function AutoConfigEditor({ api }: SlotProps) {
  const config = useSelect(api.hud, (s) => s.control.config);
  const [draft, setDraft] = useState<AutoConfig>(config);
  const set = <K extends keyof AutoConfig>(key: K, value: AutoConfig[K]) =>
    setDraft((d) => patch(d, key, value));
  return (
    <Section title="Automation">
      {NUMBER_FIELDS.map((f) => (
        <label
          key={f.key}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
          }}
        >
          <span style={{ flex: 1 }}>{f.label}</span>
          <input
            type="number"
            aria-label={f.label}
            min={f.min}
            max={f.max}
            value={draft[f.key]}
            onChange={(e) => set(f.key, Math.trunc(Number(e.target.value) || 0))}
            style={{ width: 84, minHeight: 44 }}
          />
        </label>
      ))}
      <RaritySelect
        label="Pick up items of at least"
        value={draft.pickupRarity}
        onChange={(r) => set("pickupRarity", r)}
      />
      <RaritySelect
        label="Keep items of at least (others are sold)"
        value={draft.keepRarity}
        onChange={(r) => set("keepRarity", r)}
      />
      {BOOL_FIELDS.map((f) => (
        <Toggle
          key={f.key}
          label={f.label}
          checked={draft[f.key]}
          onChange={(v) => set(f.key, v)}
        />
      ))}
      <Row style={{ marginTop: 8 }}>
        <Btn pressed onClick={() => api.act(ACTION.setAutoConfig, { config: draft })}>
          Apply automation
        </Btn>
        <Btn onClick={() => setDraft(config)}>Reset</Btn>
      </Row>
    </Section>
  );
}

export function SettingsPanel({ api }: SlotProps) {
  const settings: Settings = useSelect(api.ui, (u) => u.settings);
  const flag = (key: BoolSetting, value: boolean) => {
    const next: Partial<Settings> = {};
    next[key] = value;
    api.updateSettings(next);
  };
  return (
    <PanelFrame api={api} id="settings" title="Settings" width={440}>
      <Section title="Display">
        {FLAGS.map((f) => (
          <Toggle
            key={f.key}
            label={f.label}
            checked={settings[f.key]}
            onChange={(v) => flag(f.key, v)}
          />
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44 }}>
          <span style={{ minWidth: 70 }}>Zoom</span>
          <input
            type="range"
            aria-label="Zoom"
            min={0.5}
            max={2}
            step={0.1}
            value={settings.zoom}
            onChange={(e) => api.updateSettings({ zoom: Number(e.target.value) })}
            style={{ flex: 1, height: 44 }}
          />
          <span style={{ minWidth: 40, textAlign: "right" }}>{`${settings.zoom.toFixed(1)}×`}</span>
        </label>
      </Section>
      <AutoConfigEditor api={api} />
      <Section title="Game">
        <Row>
          <Btn
            label="Start a new game"
            onClick={() => {
              if (
                typeof window === "undefined" ||
                window.confirm("Start a new game? The local save will be wiped.")
              ) {
                api.newGame();
              }
            }}
          >
            New game
          </Btn>
          <Btn label="Exit the mode" onClick={() => api.exit()}>
            Exit
          </Btn>
        </Row>
        <p style={{ ...labelStyle, color: C.muted }}>
          New game wipes the local save. Exit leaves the classic mode.
        </p>
      </Section>
    </PanelFrame>
  );
}

/** Exported for tests: the labels of the auto config editor, in display order. */
export function autoConfigLabels(): string[] {
  const out: string[] = [];
  for (const f of NUMBER_FIELDS) out.push(f.label);
  for (const f of BOOL_FIELDS) out.push(f.label);
  return out;
}
