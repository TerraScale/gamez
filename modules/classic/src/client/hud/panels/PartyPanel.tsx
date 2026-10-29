/**
 * Party roster panel (panel "party", key P; docs/design/party.md §10.3). Roster: take control,
 * reorder, rename, dismiss (confirm; the gear goes to the stash). Recruit: class cards and a name,
 * town only, with the start level, fee and the reason it is blocked. Slots: unlocked count, the next
 * boss or the gold price. AI options: formation, spread, focus fire, revive, auto-switch.
 * Every action goes through api.act; the blocked states are shown, not sent.
 */
import { useState } from "react";
import { ACTION } from "../../../actions.ts";
import type { PartyConfig } from "../../../resources.ts";
import type { PartyMemberView, PartyView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Row, Section, type SlotProps } from "../common.tsx";
import { fmtInt, planLabel } from "../format.ts";
import { ClassPicker, HERO_NAME_MAX } from "../widgets/NewHeroScreen.tsx";
import { C, labelStyle } from "../styles.ts";

const FORMATIONS: { id: PartyConfig["formation"]; label: string; hint: string }[] = [
  { id: "wedge", label: "Wedge", hint: "Front line wide, casters behind" },
  { id: "line", label: "Line", hint: "Everyone side by side" },
  { id: "ring", label: "Ring", hint: "Spread around the leader" },
];

/** Why a recruit is blocked, in player words (null = possible). */
export function recruitBlockedText(party: PartyView): string | null {
  const r = party.recruit;
  if (r.blocked === "town") return "Recruits join you in town. Walk back to town first.";
  if (r.blocked === "slots")
    return party.slots >= party.maxMembers
      ? "Every party slot is taken."
      : `All ${party.slots} unlocked slots are taken. Unlock another slot below.`;
  if (r.blocked === "gold") return `Costs ${fmtInt(r.fee)} gold. You have ${fmtInt(party.gold)}.`;
  return null;
}

/** Member order after moving the member at `index` by `delta` (null when it cannot move). */
export function reorderOrder(
  entities: readonly number[],
  index: number,
  delta: 1 | -1,
): number[] | null {
  const j = index + delta;
  if (j < 0 || j >= entities.length) return null;
  const next = [...entities];
  [next[index], next[j]] = [next[j]!, next[index]!];
  return next;
}

/** classic.party.config patch for a spread change, kept in 1..4. */
export function spreadPatch(current: number, delta: 1 | -1): { spread: number } {
  return { spread: Math.min(4, Math.max(1, current + delta)) };
}

/** Text of the roster row's status line (controlled, leader, downed, reviving...). */
export function memberStatusText(m: PartyMemberView): string {
  const parts: string[] = [];
  if (m.controlled) parts.push("Controlled");
  if (m.leader && !m.controlled) parts.push("Leader");
  if (m.dead) parts.push("Downed");
  else if (m.reviving) parts.push(`Being revived ${m.reviving.pct}%`);
  if (!m.dead && m.plan !== "none") parts.push(planLabel(m.plan));
  if (m.unspent > 0) parts.push(`${m.unspent} to spend`);
  return parts.join(" · ");
}

function MemberRow({
  api,
  party,
  m,
  index,
  renaming,
  setRenaming,
  dismissing,
  setDismissing,
}: {
  api: SlotProps["api"];
  party: PartyView;
  m: PartyMemberView;
  index: number;
  renaming: { entity: number; name: string } | null;
  setRenaming: (r: { entity: number; name: string } | null) => void;
  dismissing: number | null;
  setDismissing: (e: number | null) => void;
}) {
  const last = party.members.length - 1;
  const order = party.members.map((x) => x.entity);
  const move = (d: 1 | -1) => {
    const next = reorderOrder(order, index, d);
    if (next) api.act(ACTION.partyReorder, { order: next });
  };
  const editing = renaming?.entity === m.entity ? renaming : null;
  const trimmed = editing ? editing.name.trim() : "";
  return (
    <li
      aria-label={`${m.key} ${m.name}`}
      style={{
        listStyle: "none",
        borderTop: `1px solid ${C.border}`,
        padding: "8px 0",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: C.faint, fontSize: 12 }}>{m.key}</span>
        <strong style={{ color: m.controlled ? C.goldBright : C.text }}>{m.name}</strong>
        <span style={labelStyle}>
          {`${m.className} · Lv ${fmtInt(m.level)}`}
          {m.founder ? " · founder" : ""}
        </span>
      </div>
      {memberStatusText(m) !== "" ? (
        <div style={{ color: m.dead ? C.danger : C.muted, fontSize: 12 }}>
          {memberStatusText(m)}
        </div>
      ) : null}
      {editing ? (
        <Row>
          <input
            aria-label={`New name for ${m.name}`}
            type="text"
            value={editing.name}
            maxLength={HERO_NAME_MAX}
            onChange={(e) => setRenaming({ entity: m.entity, name: e.target.value })}
            style={{ flex: 1, minWidth: 140, minHeight: 44 }}
          />
          <Btn
            label={`Save name for ${m.name}`}
            disabled={trimmed.length === 0}
            height={44}
            onClick={() => {
              api.act(ACTION.partyRename, { hero: m.entity, name: trimmed });
              setRenaming(null);
            }}
          >
            Save
          </Btn>
          <Btn label="Cancel rename" height={44} onClick={() => setRenaming(null)}>
            Cancel
          </Btn>
        </Row>
      ) : dismissing === m.entity ? (
        <Row>
          <span style={{ color: C.muted, flex: "1 1 200px" }}>
            {`Dismiss ${m.name}? Their gear goes to the stash. Belt potions are lost.`}
          </span>
          <Btn
            label={`Confirm dismiss ${m.name}`}
            height={44}
            onClick={() => {
              api.act(ACTION.partyDismiss, { hero: m.entity });
              setDismissing(null);
            }}
          >
            Dismiss
          </Btn>
          <Btn label="Cancel dismiss" height={44} onClick={() => setDismissing(null)}>
            Cancel
          </Btn>
        </Row>
      ) : (
        <Row style={{ gap: 6 }}>
          <Btn
            label={`Take control of ${m.name}`}
            title={m.controlled ? "Already controlled" : `Take control (${m.key})`}
            pressed={m.controlled}
            disabled={m.controlled}
            height={44}
            onClick={() => api.act(ACTION.partyControl, { hero: m.entity })}
          >
            Control
          </Btn>
          <Btn
            label={`Move ${m.name} up`}
            disabled={index === 0}
            height={44}
            minWidth={44}
            onClick={() => move(-1)}
          >
            ▲
          </Btn>
          <Btn
            label={`Move ${m.name} down`}
            disabled={index === last}
            height={44}
            minWidth={44}
            onClick={() => move(1)}
          >
            ▼
          </Btn>
          <Btn
            label={`Rename ${m.name}`}
            height={44}
            onClick={() => setRenaming({ entity: m.entity, name: m.name })}
          >
            Rename
          </Btn>
          {!m.founder ? (
            <Btn
              label={`Dismiss ${m.name}`}
              title={party.inTown ? "Dismiss from the party" : "Dismiss in town"}
              disabled={!party.inTown}
              height={44}
              onClick={() => setDismissing(m.entity)}
            >
              Dismiss
            </Btn>
          ) : null}
        </Row>
      )}
    </li>
  );
}

function Roster({ api, party }: { api: SlotProps["api"]; party: PartyView }) {
  const [renaming, setRenaming] = useState<{ entity: number; name: string } | null>(null);
  const [dismissing, setDismissing] = useState<number | null>(null);
  return (
    <ol style={{ margin: 0, padding: 0 }} aria-label="Party roster">
      {party.members.map((m, i) => (
        <MemberRow
          key={m.entity}
          api={api}
          party={party}
          m={m}
          index={i}
          renaming={renaming}
          setRenaming={setRenaming}
          dismissing={dismissing}
          setDismissing={setDismissing}
        />
      ))}
    </ol>
  );
}

function Recruit({
  api,
  party,
  classes,
}: {
  api: SlotProps["api"];
  party: PartyView;
  classes: { id: string; name: string; description: string }[];
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("Recruit");
  const classId = picked ?? classes[0]?.id ?? "";
  const trimmed = name.trim();
  const blocked = recruitBlockedText(party);
  const valid =
    blocked === null && classId !== "" && trimmed.length >= 1 && trimmed.length <= HERO_NAME_MAX;
  return (
    <div>
      <ClassPicker classes={classes} value={classId} onPick={setPicked} />
      <label style={{ display: "block", marginTop: 10, color: C.muted }}>
        New hero name
        <input
          type="text"
          value={name}
          maxLength={HERO_NAME_MAX}
          aria-label="New hero name"
          onChange={(e) => setName(e.target.value)}
          style={{ display: "block", width: "100%", marginTop: 4, minHeight: 44 }}
        />
      </label>
      <p style={{ ...labelStyle, margin: "8px 0" }}>
        {`Starts at level ${fmtInt(party.recruit.level)} for ${fmtInt(party.recruit.fee)} gold.`}
      </p>
      {blocked ? (
        <p style={{ color: C.danger, margin: "0 0 8px", fontSize: 12 }}>{blocked}</p>
      ) : null}
      <Btn
        label="Recruit"
        disabled={!valid}
        height={44}
        onClick={() => api.act(ACTION.partyRecruit, { classId, name: trimmed })}
      >
        Recruit
      </Btn>
    </div>
  );
}

function Slots({ api, party }: { api: SlotProps["api"]; party: PartyView }) {
  const full = party.slots >= party.maxMembers;
  return (
    <div>
      <p style={{ margin: "0 0 8px" }}>
        {`${party.slots} of ${party.maxMembers} slots unlocked · ${party.members.length} in the party`}
      </p>
      {full ? (
        <p style={labelStyle}>Every slot is unlocked.</p>
      ) : (
        <>
          {party.nextSlotBossDepth !== null ? (
            <p
              style={labelStyle}
            >{`Free when you defeat the boss on depth ${party.nextSlotBossDepth}.`}</p>
          ) : null}
          {party.nextSlotPrice !== null ? (
            <Btn
              label="Buy the next party slot"
              title={party.inTown ? "Buy a party slot" : "Buy slots in town"}
              disabled={!party.inTown || party.gold < party.nextSlotPrice}
              height={44}
              onClick={() => api.act(ACTION.partyBuySlot, {})}
            >
              {`Buy for ${fmtInt(party.nextSlotPrice)} gold`}
            </Btn>
          ) : null}
        </>
      )}
    </div>
  );
}

function AiOptions({ api, party }: { api: SlotProps["api"]; party: PartyView }) {
  const cfg = party.config;
  const set = (patch: Partial<PartyConfig>) => api.act(ACTION.partyConfig, { config: patch });
  const toggle = (label: string, key: "focusFire" | "revive" | "autoSwitch", hint: string) => (
    <Btn
      label={label}
      title={hint}
      pressed={cfg[key]}
      height={44}
      onClick={() => set({ [key]: !cfg[key] })}
    >
      {`${label}: ${cfg[key] ? "on" : "off"}`}
    </Btn>
  );
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        role="group"
        aria-label="Formation"
        style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
      >
        {FORMATIONS.map((f) => (
          <Btn
            key={f.id}
            label={`${f.label} formation`}
            title={f.hint}
            pressed={cfg.formation === f.id}
            height={44}
            onClick={() => set({ formation: f.id })}
          >
            {f.label}
          </Btn>
        ))}
      </div>
      <Row>
        <span style={{ color: C.muted }}>Spread</span>
        <Btn
          label="Spread closer"
          disabled={cfg.spread <= 1}
          height={44}
          minWidth={44}
          onClick={() => set(spreadPatch(cfg.spread, -1))}
        >
          −
        </Btn>
        <span aria-label="Spread value" style={{ minWidth: 24, textAlign: "center" }}>
          {cfg.spread}
        </span>
        <Btn
          label="Spread wider"
          disabled={cfg.spread >= 4}
          height={44}
          minWidth={44}
          onClick={() => set(spreadPatch(cfg.spread, 1))}
        >
          +
        </Btn>
      </Row>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {toggle("Focus fire", "focusFire", "Followers hit the leader's target")}
        {toggle("Revive", "revive", "Followers revive downed allies when no foe is near")}
        {toggle(
          "Auto-switch",
          "autoSwitch",
          "When you fall in Auto, control moves to a standing member",
        )}
      </div>
    </div>
  );
}

export function PartyPanel({ api }: SlotProps) {
  const party = useSelect(api.hud, (s) => s.party ?? null);
  const classes = useSelect(api.hud, (s) => s.classes);
  return (
    <PanelFrame
      api={api}
      id="party"
      title="Party"
      subtitle={
        party
          ? `${party.members.length} of ${party.slots} slots · ${fmtInt(party.gold)} gold`
          : undefined
      }
      width={420}
    >
      {party === null ? (
        <p style={labelStyle}>Your party appears once a hero exists.</p>
      ) : (
        <>
          <Section title="Roster">
            <Roster api={api} party={party} />
          </Section>
          <Section title="Recruit">
            <Recruit api={api} party={party} classes={classes} />
          </Section>
          <Section title="Slots">
            <Slots api={api} party={party} />
          </Section>
          <Section title="Party AI">
            <AiOptions api={api} party={party} />
          </Section>
        </>
      )}
    </PanelFrame>
  );
}
