/**
 * Smithing panel "craft" (docs/design/wave-A.md §5.6): repair, upgrade, reroll,
 * sockets and gems at the smith. Every option is a pure descriptor (label,
 * caption, enabled, the act() payload) built by the functions below, so the
 * tests check payloads and disabled reasons without a DOM.
 */
import { useState } from "react";
import type { Entity } from "@gamez/kernel";
import { ACTION } from "../../../actions.ts";
import type { ClassicClientApi, CraftItemView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, ProgressBar, Section, type SlotProps } from "../common.tsx";
import { fmtInt, RARITY_LABEL, rarityHex } from "../format.ts";
import { ItemIcon } from "../icons.tsx";
import { nameShowsUpgrade } from "../../describe.ts";
import { C, labelStyle } from "../styles.ts";

/** One smith service as the panel shows it. `act` is null when the button is disabled. */
export interface CraftOption {
  key:
    | "repair"
    | "repairAll"
    | "upgrade"
    | "reroll"
    | "addSocket"
    | "socket"
    | "unsocket"
    | "combine";
  label: string;
  /** Second line under the button: price, chance, or the reason it is disabled. */
  caption: string;
  enabled: boolean;
  act: { name: string; payload: unknown } | null;
}

/** A priced service: disabled with `nullReason` when impossible, with "Not enough gold" when unaffordable. */
function priced(
  key: CraftOption["key"],
  label: string,
  cost: number | null,
  nullReason: string,
  gold: number,
  act: { name: string; payload: unknown },
  extra?: string,
): CraftOption {
  if (cost === null) return { key, label, caption: nullReason, enabled: false, act: null };
  const affordable = gold >= cost;
  const parts = [`${fmtInt(cost)} g`, extra ?? null, affordable ? null : "Not enough gold"];
  return {
    key,
    label,
    caption: parts.filter((p) => p !== null).join(" · "),
    enabled: affordable,
    act: affordable ? act : null,
  };
}

/** The gem used by "Socket gem": the chosen gem group (or the first one), as a bag uid. */
export function pickGem<G extends { base: string; uids: number[] }>(
  gems: readonly G[],
  base: string | null,
): G | null {
  return gems.find((g) => g.base === base) ?? gems[0] ?? null;
}

/** Repair everything carried and worn (uid 0). */
export function repairAllOption(npc: Entity, repairAllCost: number, gold: number): CraftOption {
  return priced(
    "repairAll",
    "Repair all",
    repairAllCost > 0 ? repairAllCost : null,
    "Nothing to repair",
    gold,
    { name: ACTION.repair, payload: { npc, uid: 0 } },
  );
}

/** Every service of one bag or worn item, in the order the panel shows them. */
export function craftOptions(
  row: CraftItemView,
  npc: Entity,
  gold: number,
  gemUid: number | null,
): CraftOption[] {
  const uid = row.item.uid;
  const equipment = row.item.slots.length > 0;
  const sockets = row.item.sockets ?? [];
  const level = row.item.upgradeLevel ?? 0;
  const out: CraftOption[] = [];
  out.push(
    priced(
      "repair",
      "Repair",
      row.repairCost,
      row.item.durability ? "Nothing to repair" : "Cannot be repaired",
      gold,
      { name: ACTION.repair, payload: { npc, uid } },
    ),
  );
  out.push(
    priced(
      "upgrade",
      `Upgrade to +${level + 1}`,
      row.upgradeCost,
      equipment ? "Max level" : "Cannot be upgraded",
      gold,
      { name: ACTION.upgradeItem, payload: { npc, uid } },
      row.upgradeChance === null ? undefined : `${row.upgradeChance}% chance`,
    ),
  );
  out.push(
    priced("reroll", "Reroll", row.rerollCost, "Only magic and rare items", gold, {
      name: ACTION.rerollItem,
      payload: { npc, uid },
    }),
  );
  out.push(
    priced(
      "addSocket",
      "Add socket",
      row.socketCost,
      equipment ? "Max sockets" : "Cannot take sockets",
      gold,
      { name: ACTION.addSocket, payload: { npc, uid } },
    ),
  );
  const socketOk = row.canSocket && gemUid !== null;
  let socketReason = "";
  if (!socketOk) {
    if (gemUid === null) socketReason = "No gem in your bag";
    else if (sockets.length === 0) socketReason = "Add a socket first";
    else socketReason = "No empty socket";
  }
  out.push({
    key: "socket",
    label: "Socket gem",
    caption: socketOk ? "Free" : socketReason,
    enabled: socketOk,
    act:
      socketOk && gemUid !== null
        ? { name: ACTION.socketGem, payload: { npc, uid, gem: gemUid } }
        : null,
  });
  out.push(
    priced("unsocket", "Remove gems", row.unsocketCost, "No gems socketed", gold, {
      name: ACTION.unsocketGems,
      payload: { npc, uid },
    }),
  );
  return out;
}

/** Combine three bag gems of one base into one of the next tier. */
export function combineOption(
  gem: { base: string; name: string; tier: number; count: number; combineCost: number | null },
  npc: Entity,
  gold: number,
): CraftOption {
  const label = "Combine";
  if (gem.count < 3) {
    return { key: "combine", label, caption: "Needs 3 of this gem", enabled: false, act: null };
  }
  if (gem.tier >= 5) {
    return { key: "combine", label, caption: "Already radiant", enabled: false, act: null };
  }
  return priced(
    "combine",
    label,
    gem.combineCost,
    "Not available",
    gold,
    { name: ACTION.combineGems, payload: { npc, base: gem.base } },
    `3 into tier ${gem.tier + 1}`,
  );
}

function OptionButton({
  api,
  option,
  aria,
}: {
  api: ClassicClientApi;
  option: CraftOption;
  aria: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 112 }}>
      <Btn
        label={`${option.label}: ${aria}`}
        disabled={!option.enabled}
        onClick={() => {
          if (option.act) api.act(option.act.name, option.act.payload);
        }}
      >
        {option.label}
      </Btn>
      <span style={{ ...labelStyle, fontSize: 11, lineHeight: 1.25 }}>{option.caption}</span>
    </div>
  );
}

function ItemCard({
  api,
  row,
  npc,
  gold,
  gemUid,
}: {
  api: ClassicClientApi;
  row: CraftItemView;
  npc: Entity;
  gold: number;
  gemUid: number | null;
}) {
  const item = row.item;
  const color = rarityHex(item.rarity);
  const dur = item.durability ?? null;
  const pct = dur && dur.max > 0 ? (dur.cur / dur.max) * 100 : 0;
  const options = craftOptions(row, npc, gold, gemUid);
  return (
    <div style={{ padding: "8px 0", borderBottom: `1px dashed ${C.faint}` }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <ItemIcon category={item.category} color={color} size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color, fontWeight: 600 }}>
            {item.name}
            {item.upgradeLevel && !nameShowsUpgrade(item.name, item.upgradeLevel) ? (
              <span style={{ color: C.goldBright, marginLeft: 6 }}>{`+${item.upgradeLevel}`}</span>
            ) : null}
          </div>
          <div style={labelStyle}>
            {`${row.where === "equipped" ? "Equipped" : "In bag"} · ${RARITY_LABEL[item.rarity]}`}
            {item.broken ? " · Broken" : ""}
          </div>
          {dur ? (
            <div style={{ marginTop: 4 }}>
              <div style={{ ...labelStyle, fontSize: 11 }}>
                {item.broken ? "Broken" : `Durability ${fmtInt(dur.cur)} / ${fmtInt(dur.max)}`}
              </div>
              <ProgressBar
                pct={pct}
                color={item.broken ? C.danger : C.ok}
                height={6}
                label={`Durability of ${item.name}`}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {options.map((o) => (
          <OptionButton key={o.key} api={api} option={o} aria={item.name} />
        ))}
      </div>
    </div>
  );
}

export function CraftPanel({ api }: SlotProps) {
  const craft = useSelect(api.hud, (s) => s.craft ?? null);
  const gold = useSelect(api.hud, (s) => (s.hero ? s.hero.gold : 0));
  const [gemPick, setGemPick] = useState<string | null>(null);
  if (!craft) {
    return (
      <PanelFrame api={api} id="craft" title="Smithing" width={420}>
        <p style={labelStyle}>The smith is not working right now. Visit the smith in town.</p>
      </PanelFrame>
    );
  }
  const gem = pickGem(craft.gems, gemPick);
  const gemUid = gem?.uids[0] ?? null;
  const repairAll = repairAllOption(craft.npc, craft.repairAllCost, gold);
  const gear = craft.items.filter((r) => r.item.category !== "gem");
  return (
    <PanelFrame
      api={api}
      id="craft"
      title="Smithing"
      width={480}
      subtitle={`Gold ${fmtInt(gold)} · the smith works in town`}
    >
      <Section title="Repair">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <OptionButton api={api} option={repairAll} aria="everything you carry and wear" />
          <span style={labelStyle}>
            Repair costs scale with the missing durability. Broken items give no stats until
            repaired.
          </span>
        </div>
      </Section>
      <Section title="Equipment and bag">
        {gear.length === 0 ? <p style={labelStyle}>Nothing to craft on yet.</p> : null}
        {gear.map((row) => (
          <ItemCard
            key={`${row.where}-${row.item.uid}`}
            api={api}
            row={row}
            npc={craft.npc}
            gold={gold}
            gemUid={gemUid}
          />
        ))}
      </Section>
      <Section title="Gems">
        {craft.gems.length === 0 ? (
          <p style={labelStyle}>No gems in your bag. Monsters drop them, and sockets hold them.</p>
        ) : null}
        {craft.gems.length > 0 ? (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 6,
            }}
          >
            <span style={labelStyle}>Gem to socket</span>
            <select
              aria-label="Gem to socket"
              value={gem?.base ?? ""}
              onChange={(e) => setGemPick(e.target.value)}
            >
              {craft.gems.map((g) => (
                <option key={g.base} value={g.base}>
                  {`${g.name} (tier ${g.tier}) × ${g.count}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {craft.gems.map((g) => (
          <div
            key={g.base}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "6px 0",
              borderBottom: `1px dashed ${C.faint}`,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ color: rarityHex("magic"), fontWeight: 600 }}>{g.name}</div>
              <div style={labelStyle}>{`Tier ${g.tier} of 5 · ${fmtInt(g.count)} in your bag`}</div>
            </div>
            <OptionButton api={api} option={combineOption(g, craft.npc, gold)} aria={g.name} />
          </div>
        ))}
      </Section>
    </PanelFrame>
  );
}
