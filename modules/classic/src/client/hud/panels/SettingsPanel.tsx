/**
 * Settings (panel "settings"): display toggles and zoom, audio (master, effects, music, mute),
 * graphics quality, tips, the loot filter entry, the automation editor and the game buttons.
 * Every control calls the handlers of settingsHandlers(), so the payloads are unit-tested.
 */
import { useState } from "react";
import { ACTION } from "../../../actions.ts";
import { ITEM_RARITIES, type ItemRarity } from "../../../types.ts";
import { DEFAULT_AUTO_CONFIG, type AutoConfig } from "../../../resources.ts";
import type { ClassicClientApi, GraphicsQuality, Settings } from "../../contract.ts";
import { tipsStore } from "../../tips/index.ts";
import { TITLE_STORAGE_KEY } from "./AchievementsPanel.tsx";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Row, Section, type SlotProps } from "../common.tsx";
import { C, labelStyle } from "../styles.ts";

type BoolSetting =
  | "showDamageNumbers"
  | "showLootLabels"
  | "showMinimap"
  | "lighting"
  | "showPerf"
  | "outlineHero";

/** Display toggles, in display order (exported for tests). */
export const DISPLAY_FLAGS: readonly { key: BoolSetting; label: string }[] = [
  { key: "outlineHero", label: "Outline my hero" },
  { key: "showDamageNumbers", label: "Damage numbers" },
  { key: "showLootLabels", label: "Loot labels" },
  { key: "showMinimap", label: "Minimap (M)" },
  { key: "lighting", label: "Lighting" },
  { key: "showPerf", label: "Performance overlay" },
];

export type VolumeSetting = "masterVolume" | "sfxVolume" | "musicVolume";

const VOLUMES: { key: VolumeSetting; label: string }[] = [
  { key: "masterVolume", label: "Master volume" },
  { key: "sfxVolume", label: "Sound effects" },
  { key: "musicVolume", label: "Music" },
];

/** Graphics quality choices, in display order. */
export const QUALITY_OPTIONS: readonly { value: GraphicsQuality; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
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
  | "pickupPotions"
  | "autoRepair"
  | "autoCraft"
  | "autoGamble"
  | "autoRift";
const BOOL_FIELDS: { key: BoolField; label: string }[] = [
  { key: "autoEquip", label: "Equip upgrades" },
  { key: "autoAllocate", label: "Spend attribute points" },
  { key: "autoDescend", label: "Descend when the level is explored" },
  { key: "buyPotions", label: "Buy potions in town" },
  { key: "pickupGold", label: "Pick up gold" },
  { key: "pickupPotions", label: "Pick up potions" },
  { key: "autoRepair", label: "Repair worn gear at the smith" },
  { key: "autoCraft", label: "Craft with spare gold (smith)" },
  { key: "autoGamble", label: "Gamble with spare gold" },
  { key: "autoRift", label: "Run Rifts once the dungeon is done" },
];

/** Clamps a slider value to an integer 0..100. */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

/**
 * Every action the settings panel can take, as plain calls on the client API. The JSX only
 * binds these to controls, so tests can assert each payload without a DOM.
 */
export function settingsHandlers(api: ClassicClientApi) {
  return {
    flag(key: BoolSetting, value: boolean): void {
      const next: Partial<Settings> = {};
      next[key] = value;
      api.updateSettings(next);
    },
    zoom(value: number): void {
      api.updateSettings({ zoom: value });
    },
    volume(key: VolumeSetting, value: number): void {
      api.updateSettings({ [key]: clampVolume(value) } as Partial<Settings>);
    },
    muted(value: boolean): void {
      api.updateSettings({ muted: value });
    },
    quality(value: GraphicsQuality): void {
      api.updateSettings({ quality: value });
    },
    tips(value: boolean): void {
      api.updateSettings({ tips: value });
    },
    resetTips(): void {
      tipsStore.reset();
    },
    lootFilter(): void {
      api.openPanel("lootFilter");
    },
    applyAutomation(config: AutoConfig): void {
      api.act(ACTION.setAutoConfig, { config });
    },
  };
}

/** What "Reset progress" wipes, shown in the confirmation (account bank and cosmetics are kept). */
export const RESET_PROGRESS_WARNING =
  "Reset all Classic progress and start from scratch?\n\n" +
  "This permanently deletes your hero, level, items, gold, quests, achievements and rift progress " +
  "(on this device and on the server). Your account, bank and cosmetics are kept.";

/**
 * Wipes classic progress: the hero (local save, server instance and sync cache via
 * api.newGame), dismissed tips and the chosen title. Returns false when the player cancels.
 */
export function resetProgress(
  api: Pick<ClassicClientApi, "newGame" | "closeAll">,
  confirm: (message: string) => boolean = (m) =>
    typeof window === "undefined" ? true : window.confirm(m),
): boolean {
  if (!confirm(RESET_PROGRESS_WARNING)) return false;
  tipsStore.reset();
  try {
    globalThis.localStorage?.removeItem(TITLE_STORAGE_KEY);
  } catch {
    // Storage blocked: the title is display-only.
  }
  api.closeAll();
  api.newGame();
  return true;
}

/** The automation draft with every field filled (stored configs may predate the wave A fields). */
export function fullAutoConfig(config: Partial<AutoConfig> | undefined): AutoConfig {
  return { ...DEFAULT_AUTO_CONFIG, ...config };
}

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

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44 }}>
      <span style={{ minWidth: 120 }}>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, height: 44 }}
      />
      <span style={{ minWidth: 40, textAlign: "right" }}>{`${value}%`}</span>
    </label>
  );
}

function AutoConfigEditor({
  api,
  handlers,
}: SlotProps & { handlers: ReturnType<typeof settingsHandlers> }) {
  const config = useSelect(api.hud, (s) => s.control.config);
  const [draft, setDraft] = useState<AutoConfig>(() => fullAutoConfig(config));
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
          checked={draft[f.key] ?? DEFAULT_AUTO_CONFIG[f.key] ?? false}
          onChange={(v) => set(f.key, v)}
        />
      ))}
      <Row style={{ marginTop: 8 }}>
        <Btn pressed onClick={() => handlers.applyAutomation(draft)}>
          Apply automation
        </Btn>
        <Btn onClick={() => setDraft(fullAutoConfig(config))}>Reset</Btn>
      </Row>
    </Section>
  );
}

export function SettingsPanel({ api }: SlotProps) {
  const settings: Settings = useSelect(api.ui, (u) => u.settings);
  const handlers = settingsHandlers(api);
  return (
    <PanelFrame api={api} id="settings" title="Settings" width={440}>
      <Section title="Game">
        <Row>
          <Btn
            label="Reset progress: delete this hero and start from scratch"
            onClick={() => resetProgress(api)}
            style={{ borderColor: C.danger, color: C.danger }}
          >
            Reset progress
          </Btn>
          <Btn label="Exit the mode" onClick={() => api.exit()}>
            Exit
          </Btn>
        </Row>
        <p style={{ ...labelStyle, color: C.muted }}>
          Reset progress deletes your Classic hero, items, gold, quests and achievements (here and
          on the server) and starts from scratch. Your account, bank and cosmetics are kept. Exit
          leaves the classic mode.
        </p>
      </Section>
      <Section title="Display">
        {DISPLAY_FLAGS.map((f) => (
          <Toggle
            key={f.key}
            label={f.label}
            checked={settings[f.key]}
            onChange={(v) => handlers.flag(f.key, v)}
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
            onChange={(e) => handlers.zoom(Number(e.target.value))}
            style={{ flex: 1, height: 44 }}
          />
          <span style={{ minWidth: 40, textAlign: "right" }}>{`${settings.zoom.toFixed(1)}×`}</span>
        </label>
      </Section>
      <Section title="Audio">
        {VOLUMES.map((v) => (
          <Slider
            key={v.key}
            label={v.label}
            value={settings[v.key]}
            onChange={(n) => handlers.volume(v.key, n)}
          />
        ))}
        <Toggle label="Mute" checked={settings.muted} onChange={(v) => handlers.muted(v)} />
      </Section>
      <Section title="Graphics">
        <div role="radiogroup" aria-label="Graphics quality" style={{ display: "flex", gap: 6 }}>
          {QUALITY_OPTIONS.map((q) => (
            <Btn
              key={q.value}
              label={`Graphics quality: ${q.label}`}
              pressed={settings.quality === q.value}
              minWidth={72}
              onClick={() => handlers.quality(q.value)}
            >
              {q.label}
            </Btn>
          ))}
        </div>
      </Section>
      <Section title="Help and items">
        <Toggle label="Show tips" checked={settings.tips} onChange={(v) => handlers.tips(v)} />
        <Row>
          <Btn label="Reset tips" onClick={() => handlers.resetTips()}>
            Reset tips
          </Btn>
          <Btn label="Loot filter" onClick={() => handlers.lootFilter()}>
            Loot filter...
          </Btn>
        </Row>
      </Section>
      <AutoConfigEditor api={api} handlers={handlers} />
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
