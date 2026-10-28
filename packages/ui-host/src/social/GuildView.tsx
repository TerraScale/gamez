/**
 * Guild browser, roster and create form (wave-B.md §6, §8.3). Guests can browse
 * but not create or join. Presentational parts are exported for tests.
 */
import { useState, type CSSProperties, type FormEvent } from "react";
import {
  GUILD_MAX_MEMBERS,
  type GuildInfo,
  type GuildMember,
  type GuildSummary,
} from "@gamez/protocol";
import type { AccountView, ChatApi, GuildApi } from "../platform.ts";
import { ChatWindow } from "./ChatWindow.tsx";
import { useDebounced, useLoad } from "./hooks.ts";
import {
  checkCreateGuild,
  createGuild,
  guildJoinBlock,
  loadGuildList,
  toLoadState,
  type CreateGuildForm,
  type LoadState,
} from "./flows.ts";
import { canKick, guildErrorText, memberCountText, roleLabel } from "./text.ts";
import {
  SOCIAL_C,
  SOCIAL_TOUCH,
  badgeStyle,
  errorTextStyle,
  fieldLabelStyle,
  headingStyle,
  inputStyle,
  listStyle,
  mutedStyle,
  okTextStyle,
  rowStyle,
  sheetStyle,
  socialButtonStyle,
  subheadingStyle,
} from "./styles.ts";

export interface GuildViewProps {
  guilds: GuildApi;
  /** Current account (guests can browse but not create or join). */
  account: AccountView | null;
  /** When given, the roster view embeds the guild chat channel. */
  chat?: ChatApi;
  compact?: boolean;
  /** Called after create/join/leave so the host can refresh the account. */
  onChanged?: () => void;
}

type MineState = LoadState<GuildInfo | null>;

export function GuildView({ guilds, account, chat, compact = false, onChanged }: GuildViewProps) {
  const canUse = account !== null && account.kind === "registered";
  const [revision, setRevision] = useState(0);
  const mineLoaded = useLoad<MineState>(
    () =>
      canUse
        ? guilds
            .mine()
            .then((r) => toLoadState(r))
            .catch((): MineState => ({ status: "error", message: "Could not reach guilds." }))
        : Promise.resolve<MineState>({ status: "ready", value: null }),
    [guilds, canUse, revision],
  );
  const mine: MineState | undefined = canUse ? mineLoaded : { status: "ready", value: null };

  const [typed, setTyped] = useState("");
  const query = useDebounced(typed, 250);
  const list = useLoad<LoadState<GuildSummary[]>>(
    () =>
      loadGuildList(guilds, query).catch((): LoadState<GuildSummary[]> => ({
        status: "error",
        message: "Could not reach guilds.",
      })),
    [guilds, query, revision],
  );

  const changed = () => {
    setRevision((r) => r + 1);
    onChanged?.();
  };

  const inGuild = mine?.status === "ready" && mine.value !== null ? mine.value : null;

  return (
    <section aria-label="Guilds" style={{ ...sheetStyle, padding: compact ? 8 : 12 }}>
      {!canUse ? (
        <p role="status" style={{ ...mutedStyle, color: SOCIAL_C.gold }}>
          Create an account to join a guild.
        </p>
      ) : null}
      {mine === undefined ? (
        <p role="status" style={mutedStyle}>
          Loading your guild…
        </p>
      ) : null}
      {mine?.status === "error" ? (
        <p role="alert" style={errorTextStyle}>
          {mine.message}
        </p>
      ) : null}
      {inGuild ? (
        <GuildRoster
          info={inGuild}
          selfId={account?.accountId ?? null}
          guilds={guilds}
          chat={chat}
          compact={compact}
          onChanged={changed}
        />
      ) : mine === undefined ? null : (
        <GuildBrowse
          guilds={guilds}
          account={account}
          canUse={canUse}
          typed={typed}
          onTyped={setTyped}
          list={list}
          compact={compact}
          onChanged={changed}
          onRefresh={() => setRevision((r) => r + 1)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Roster (in a guild)
// ---------------------------------------------------------------------------

export function GuildRoster({
  info,
  selfId,
  guilds,
  chat,
  compact = false,
  onChanged,
}: {
  info: GuildInfo;
  selfId: string | null;
  guilds: GuildApi;
  chat?: ChatApi;
  compact?: boolean;
  onChanged: () => void;
}) {
  const me = info.members.find((m) => m.accountId === selfId) ?? null;
  const viewerRole = me?.role ?? null;
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = () => {
    setBusy(true);
    setError(null);
    void guilds.leave().then((r) => {
      setBusy(false);
      setConfirm(null);
      if (r.ok) onChanged();
      else setError(guildErrorText(r.code, r.message));
    });
  };

  const kick = (member: GuildMember) => {
    setBusy(true);
    setError(null);
    void guilds.kick(member.accountId).then((r) => {
      setBusy(false);
      setConfirm(null);
      if (r.ok) onChanged();
      else setError(guildErrorText(r.code, r.message));
    });
  };

  return (
    <>
      <header style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <h2 style={headingStyle}>
          {info.name} <span style={{ color: SOCIAL_C.gold }}>{`<${info.tag}>`}</span>
        </h2>
        <p style={mutedStyle}>
          {`${memberCountText(info.members.length)} of ${GUILD_MAX_MEMBERS} · ${
            info.open ? "Open to join" : "Invite only"
          }`}
        </p>
        {me ? <p style={mutedStyle}>{`Your role: ${roleLabel(me.role)}`}</p> : null}
      </header>

      <h3 style={subheadingStyle}>Roster</h3>
      <ul
        aria-label="Guild roster"
        style={{ ...listStyle, maxHeight: compact ? 180 : 320, overflowY: "auto" }}
      >
        {info.members.map((m) => {
          const same = m.accountId === selfId;
          const kickable = canKick(viewerRole, m.role, same);
          return (
            <li key={m.accountId} style={memberLook}>
              <div style={{ ...rowStyle, flex: "1 1 auto", minWidth: 0 }}>
                <span
                  style={{
                    fontWeight: 700,
                    color: same ? SOCIAL_C.goldBright : SOCIAL_C.text,
                    overflowWrap: "anywhere",
                  }}
                >
                  {m.displayName}
                </span>
                {same ? <span style={{ ...mutedStyle, fontSize: 11 }}>(you)</span> : null}
                <span style={badgeStyle}>{roleLabel(m.role)}</span>
              </div>
              {kickable && confirm !== m.accountId ? (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Kick ${m.displayName}`}
                  onClick={() => setConfirm(m.accountId)}
                  style={socialButtonStyle({ danger: true, disabled: busy })}
                >
                  Kick
                </button>
              ) : null}
              {kickable && confirm === m.accountId ? (
                <div style={rowStyle}>
                  <span style={mutedStyle}>{`Kick ${m.displayName}?`}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => kick(m)}
                    style={socialButtonStyle({ danger: true, disabled: busy })}
                  >
                    Confirm kick
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirm(null)}
                    style={socialButtonStyle()}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? (
        <p role="alert" style={errorTextStyle}>
          {error}
        </p>
      ) : null}

      {confirm === "leave" ? (
        <div style={rowStyle} role="group" aria-label="Confirm leaving">
          <span style={mutedStyle}>{`Leave ${info.name}?`}</span>
          <button
            type="button"
            disabled={busy}
            onClick={leave}
            style={socialButtonStyle({ danger: true, disabled: busy })}
          >
            Confirm leave
          </button>
          <button type="button" onClick={() => setConfirm(null)} style={socialButtonStyle()}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirm("leave")}
          style={socialButtonStyle({ danger: true, disabled: busy, fullWidth: true })}
        >
          Leave guild
        </button>
      )}

      {chat ? (
        <ChatWindow
          chat={chat}
          channels={[{ id: `guild:${info.id}`, label: "Guild chat" }]}
          selfId={selfId}
          compact={compact}
        />
      ) : null}
    </>
  );
}

const memberLook: CSSProperties = {
  display: "flex",
  // The list is a scrolling flex column: without this, rows shrink below their button (QA wave B).
  flexShrink: 0,
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
  minHeight: SOCIAL_TOUCH,
  padding: "4px 8px",
  borderRadius: 8,
  background: SOCIAL_C.field,
  border: `1px solid ${SOCIAL_C.border}`,
  minWidth: 0,
  boxSizing: "border-box",
};

// ---------------------------------------------------------------------------
// Browse and create (not in a guild)
// ---------------------------------------------------------------------------

export function GuildBrowse({
  guilds,
  account,
  canUse,
  typed,
  onTyped,
  list,
  compact = false,
  onChanged,
  onRefresh,
}: {
  guilds: GuildApi;
  account: AccountView | null;
  canUse: boolean;
  typed: string;
  onTyped: (q: string) => void;
  list: LoadState<GuildSummary[]> | undefined;
  compact?: boolean;
  onChanged: () => void;
  /** Reloads the directory (other players create guilds while the sheet is open). */
  onRefresh?: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  const join = (guild: GuildSummary) => {
    setPending(guild.id);
    setJoinError(null);
    void guilds.join(guild.id).then((r) => {
      setPending(null);
      if (r.ok) onChanged();
      else setJoinError(guildErrorText(r.code, r.message));
    });
  };

  return (
    <>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <h2 style={headingStyle}>Guilds</h2>
        {onRefresh ? (
          <button
            type="button"
            aria-label="Refresh guilds"
            disabled={list?.status === "loading"}
            onClick={onRefresh}
            style={socialButtonStyle({ disabled: list?.status === "loading" })}
          >
            Refresh
          </button>
        ) : null}
      </div>
      <label style={{ ...fieldLabelStyle, display: "flex", flexDirection: "column", gap: 4 }}>
        Search guilds
        <input
          type="search"
          aria-label="Search guilds"
          value={typed}
          placeholder="Guild name"
          onChange={(e) => onTyped(e.target.value)}
          style={inputStyle}
        />
      </label>
      <GuildList
        list={list}
        account={account}
        canUse={canUse}
        pendingId={pending}
        joinError={joinError}
        compact={compact}
        onJoin={join}
      />
      {canUse ? <CreateGuild guilds={guilds} onCreated={onChanged} /> : null}
    </>
  );
}

export function GuildList({
  list,
  account,
  canUse,
  pendingId,
  joinError,
  compact = false,
  onJoin,
}: {
  list: LoadState<GuildSummary[]> | undefined;
  account: AccountView | null;
  canUse: boolean;
  pendingId: string | null;
  joinError: string | null;
  compact?: boolean;
  onJoin: (g: GuildSummary) => void;
}) {
  if (!list || list.status === "loading") {
    return (
      <p role="status" style={mutedStyle}>
        Loading guilds…
      </p>
    );
  }
  if (list.status === "error") {
    return (
      <p role="alert" style={errorTextStyle}>
        {`Guilds could not load. ${list.message}`}
      </p>
    );
  }
  if (list.value.length === 0) {
    return (
      <p role="status" style={mutedStyle}>
        {canUse ? "No guilds match. Create the first one below." : "No guilds match."}
      </p>
    );
  }
  return (
    <>
      {joinError ? (
        <p role="alert" style={errorTextStyle}>
          {joinError}
        </p>
      ) : null}
      <ul
        aria-label="Guilds"
        style={{ ...listStyle, maxHeight: compact ? 200 : 360, overflowY: "auto" }}
      >
        {list.value.map((g) => {
          const block = guildJoinBlock(g, account);
          const joinable = block === null && canUse;
          return (
            <li key={g.id} style={memberLook}>
              <div
                style={{
                  flex: "1 1 auto",
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <span style={{ fontWeight: 700, overflowWrap: "anywhere" }}>
                  {g.name} <span style={{ color: SOCIAL_C.gold }}>{`<${g.tag}>`}</span>
                </span>
                <span
                  style={mutedStyle}
                >{`${memberCountText(g.memberCount)} · ${g.open ? "Open" : "Invite only"}`}</span>
              </div>
              <button
                type="button"
                disabled={!joinable || pendingId !== null}
                aria-label={`Join ${g.name}`}
                onClick={() => onJoin(g)}
                style={{
                  ...socialButtonStyle({
                    primary: joinable,
                    disabled: !joinable || pendingId !== null,
                  }),
                  flex: "0 0 auto",
                  maxWidth: "100%",
                }}
              >
                {joinable ? (pendingId === g.id ? "Joining…" : "Join") : (block ?? "Join")}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function CreateGuild({ guilds, onCreated }: { guilds: GuildApi; onCreated: () => void }) {
  const [form, setForm] = useState<CreateGuildForm>({ name: "", tag: "", open: true });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const local = checkCreateGuild(form);
    setDone(null);
    if (local) {
      setProblem(local);
      return;
    }
    setBusy(true);
    setProblem(null);
    void createGuild(guilds, form).then((r) => {
      setBusy(false);
      if (r.ok) {
        setForm({ name: "", tag: "", open: true });
        setDone(`${r.value.name} is founded. Welcome, leader.`);
        onCreated();
      } else {
        setProblem(r.message);
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Create a guild"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <h3 style={subheadingStyle}>Create a guild</h3>
      <p style={mutedStyle}>
        Names are 3 to 24 letters or numbers. Tags are 2 to 5 letters or numbers.
      </p>
      <label style={{ ...fieldLabelStyle, display: "flex", flexDirection: "column", gap: 4 }}>
        Guild name
        <input
          type="text"
          value={form.name}
          maxLength={40}
          autoComplete="off"
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          style={inputStyle}
        />
      </label>
      <label style={{ ...fieldLabelStyle, display: "flex", flexDirection: "column", gap: 4 }}>
        Tag
        <input
          type="text"
          value={form.tag}
          maxLength={5}
          autoComplete="off"
          onChange={(e) => setForm({ ...form, tag: e.target.value.toUpperCase() })}
          style={inputStyle}
        />
      </label>
      <label style={{ ...rowStyle, minHeight: SOCIAL_TOUCH, color: SOCIAL_C.text }}>
        <input
          type="checkbox"
          checked={form.open}
          onChange={(e) => setForm({ ...form, open: e.target.checked })}
          style={{ width: 22, height: 22 }}
        />
        Open to everyone
      </label>
      {problem ? (
        <p role="alert" style={errorTextStyle}>
          {problem}
        </p>
      ) : null}
      {done ? (
        <p role="status" style={okTextStyle}>
          {done}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        style={socialButtonStyle({ primary: true, disabled: busy, fullWidth: true })}
      >
        {busy ? "Founding…" : "Found guild"}
      </button>
    </form>
  );
}
