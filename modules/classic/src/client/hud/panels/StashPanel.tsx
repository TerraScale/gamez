/**
 * Stash chest (panel "stash"): tab strip with counts, the items of the selected
 * tab (take, or move to another tab), and the bag (put into the selected tab).
 * The selected tab is UI state shared with the inventory's "Stash" button.
 */
import { useSyncExternalStore } from "react";
import { ACTION } from "../../../actions.ts";
import type { ItemView, StashTabView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Section, type SlotProps } from "../common.tsx";
import { fmtInt, pluralize, rarityHex } from "../format.ts";
import { ItemIcon } from "../icons.tsx";
import { C, labelStyle } from "../styles.ts";

// ---- the selected stash tab (UI state, not sim state) ----

let selectedTab = 0;
const tabListeners = new Set<() => void>();

/** Index of the tab the stash panel shows (and the inventory's Stash button puts into). */
export function selectStashTab(index: number): void {
  const next = Math.max(0, Math.trunc(index));
  if (next === selectedTab) return;
  selectedTab = next;
  for (const cb of tabListeners) cb();
}

function subscribeTab(cb: () => void): () => void {
  tabListeners.add(cb);
  return () => {
    tabListeners.delete(cb);
  };
}

/** The selected stash tab index, re-rendering on change. */
export function useSelectedStashTab(): number {
  return useSyncExternalStore(
    subscribeTab,
    () => selectedTab,
    () => selectedTab,
  );
}

/** Tabs to show: the snapshot's tabs, or one tab of the whole stash when the snapshot has none. */
export function tabsOrDefault(
  tabs: readonly StashTabView[],
  stashCount: number,
  stashSize: number,
): StashTabView[] {
  if (tabs.length > 0) return [...tabs];
  return [{ index: 0, name: "Stash", count: stashCount, size: stashSize }];
}

/** The tab index actually shown: the selection clamped to the tabs that exist. */
export function clampTab(index: number, tabCount: number): number {
  return Math.min(Math.max(0, index), Math.max(0, tabCount - 1));
}

// ---- entries ----

function Entry({
  item,
  tabs,
  current,
  onTake,
  onMove,
}: {
  item: ItemView;
  tabs: readonly StashTabView[];
  current: number;
  onTake: () => void;
  onMove: (tab: number) => void;
}) {
  const color = rarityHex(item.rarity);
  const others = tabs.filter((t) => t.index !== current);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 0",
        borderBottom: `1px dashed ${C.faint}`,
        flexWrap: "wrap",
      }}
    >
      <ItemIcon category={item.category} color={color} size={28} />
      <div style={{ flex: 1, minWidth: 140 }}>
        <div style={{ color, fontWeight: 600 }}>{item.name}</div>
        <div style={labelStyle}>{item.lines.join(" · ")}</div>
      </div>
      {others.length > 0 ? (
        <select
          aria-label={`Move ${item.name} to tab`}
          value=""
          onChange={(e) => {
            const tab = Number(e.target.value);
            if (Number.isInteger(tab)) onMove(tab);
          }}
          style={{ minHeight: 44 }}
        >
          <option value="">Move to…</option>
          {others.map((t) => (
            <option key={t.index} value={t.index}>
              {t.name}
            </option>
          ))}
        </select>
      ) : null}
      <Btn label={`Take ${item.name}`} onClick={onTake}>
        Take
      </Btn>
    </div>
  );
}

export function StashPanel({ api }: SlotProps) {
  const stash = useSelect(api.hud, (s) => s.stash);
  const size = useSelect(api.hud, (s) => s.stashSize);
  const tabsView = useSelect(api.hud, (s) => s.stashTabs ?? []);
  const bag = useSelect(api.hud, (s) => s.inventory.items.map((p) => p.item));
  const inTown = useSelect(api.hud, (s) => s.area?.isTown ?? false);
  const picked = useSelectedStashTab();
  const tabs = tabsOrDefault(tabsView, stash.length, size);
  const current = clampTab(picked, tabs.length);
  const tab = tabs[current];
  const inTab = stash.filter((it) => (it.tab ?? 0) === current);
  return (
    <PanelFrame
      api={api}
      id="stash"
      title="Stash"
      width={460}
      subtitle={`${fmtInt(stash.length)} of ${pluralize(size * tabs.length, "slot")}${inTown ? "" : " · the stash is in town"}`}
    >
      <div
        role="tablist"
        aria-label="Stash tabs"
        style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}
      >
        {tabs.map((t) => (
          <Btn
            key={t.index}
            label={`${t.name}, ${fmtInt(t.count)} items`}
            pressed={t.index === current}
            minWidth={96}
            fontSize={12}
            onClick={() => selectStashTab(t.index)}
          >
            {`${t.name} · ${fmtInt(t.count)}/${fmtInt(t.size)}`}
          </Btn>
        ))}
      </div>
      <Section title={tab ? `In ${tab.name}` : "In the stash"}>
        {inTab.length === 0 ? <p style={labelStyle}>This tab is empty.</p> : null}
        {inTab.map((item) => (
          <Entry
            key={item.uid}
            item={item}
            tabs={tabs}
            current={current}
            onTake={() => api.act(ACTION.stashTake, { uid: item.uid })}
            onMove={(to) => api.act(ACTION.stashMove, { uid: item.uid, tab: to })}
          />
        ))}
      </Section>
      <Section title="In your bag">
        {bag.length === 0 ? <p style={labelStyle}>Your bag is empty.</p> : null}
        {bag.map((item) => (
          <div
            key={item.uid}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 0",
              borderBottom: `1px dashed ${C.faint}`,
            }}
          >
            <ItemIcon category={item.category} color={rarityHex(item.rarity)} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: rarityHex(item.rarity), fontWeight: 600 }}>{item.name}</div>
              <div style={labelStyle}>{item.lines.join(" · ")}</div>
            </div>
            <Btn
              label={`Put ${item.name} into ${tab?.name ?? "the stash"}`}
              onClick={() => api.act(ACTION.stashPut, { uid: item.uid, tab: current })}
            >
              Put
            </Btn>
          </div>
        ))}
      </Section>
    </PanelFrame>
  );
}
