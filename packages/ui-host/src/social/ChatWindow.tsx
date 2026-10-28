/**
 * Chat window with channel tabs (wave-B.md §5, §8.3). One ChatChannelClient per
 * tab, opened on mount. Presentational parts are exported for tests.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { CHAT_MAX_LEN, type ChatMessage, type ReportReason } from "@gamez/protocol";
import type { ChannelId, ChatApi, ChatChannelView } from "../platform.ts";
import { useChannelClients, useChannelView } from "./hooks.ts";
import { sendChat } from "./flows.ts";
import {
  chatErrorText,
  formatClock,
  parseReportReason,
  isMuted,
  isNearBottom,
  REPORT_REASONS,
  reportReasonText,
} from "./text.ts";
import {
  SOCIAL_C,
  SOCIAL_TOUCH,
  errorTextStyle,
  fieldLabelStyle,
  inputStyle,
  mutedStyle,
  rowStyle,
  sheetStyle,
  socialButtonStyle,
  socialTabStyle,
  okTextStyle,
} from "./styles.ts";

export interface ChatWindowProps {
  chat: ChatApi;
  /** Channels to show as tabs, first selected: e.g. ["global", "mode:classic", "guild:<id>"]. */
  channels: readonly { id: ChannelId; label: string }[];
  /** Own account id (own messages are styled, no block/report menu). */
  selfId: string | null;
  /** Narrow layout (HUD side panel / phone). */
  compact?: boolean;
  onClose?: () => void;
}

const STATUS_TEXT: Record<ChatChannelView["status"], string> = {
  connecting: "Connecting…",
  online: "Live",
  offline: "Offline, reconnecting…",
  closed: "Chat closed",
};

export function ChatWindow(props: ChatWindowProps) {
  const { chat, channels, selfId, compact = false, onClose } = props;
  const clients = useChannelClients(
    chat,
    channels.map((c) => c.id),
  );
  const [picked, setPicked] = useState<ChannelId | null>(null);
  const active = channels.find((c) => c.id === picked) ?? channels[0];
  const client = active ? clients.get(active.id) : undefined;
  const view = useChannelView(client);
  const now = useNow(view.mutedUntil != null);
  const muted = isMuted(view.mutedUntil, now);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reported, setReported] = useState<Record<string, true>>({});

  if (!active) {
    return (
      <section aria-label="Chat" style={sheetStyle}>
        <p style={mutedStyle}>No chat channels here.</p>
      </section>
    );
  }

  const serverError = view.error
    ? chatErrorText(view.error.code, { mutedUntil: view.mutedUntil, message: view.error.message })
    : null;
  const errorLine = localError ?? serverError;
  const canSend = client !== undefined && view.status === "online" && !muted && !sending;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!client || !canSend) return;
    setSending(true);
    setLocalError(null);
    void sendChat(client, draft).then((r) => {
      setSending(false);
      if (r.ok) setDraft("");
      else
        setLocalError(chatErrorText(r.code, { mutedUntil: view.mutedUntil, message: r.message }));
    });
  };

  return (
    <section aria-label="Chat" style={{ ...sheetStyle, gap: 8, padding: compact ? 8 : 12 }}>
      <header style={{ ...rowStyle, justifyContent: "space-between" }}>
        <ChatTabs channels={channels} selected={active.id} onSelect={setPicked} />
        <div style={rowStyle}>
          <span role="status" style={mutedStyle}>
            {STATUS_TEXT[view.status]}
          </span>
          {onClose ? (
            <button
              type="button"
              aria-label="Close chat"
              onClick={onClose}
              style={socialButtonStyle()}
            >
              Close
            </button>
          ) : null}
        </div>
      </header>
      <ChatLog
        messages={view.messages}
        selfId={selfId}
        compact={compact}
        reported={reported}
        onBlock={(accountId) => client?.block(accountId, true)}
        onReport={(id, reason) => {
          client?.report(id, reason);
          setReported((r) => ({ ...r, [id]: true }));
        }}
      />
      <ChatComposer
        draft={draft}
        onDraft={setDraft}
        onSubmit={onSubmit}
        canSend={canSend}
        sending={sending}
        status={view.status}
        mutedUntil={muted ? view.mutedUntil : null}
        error={errorLine}
        compact={compact}
      />
    </section>
  );
}

/** Ticks once a second while `active` (a mute countdown), otherwise stays put. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function ChatTabs({
  channels,
  selected,
  onSelect,
}: {
  channels: readonly { id: ChannelId; label: string }[];
  selected: ChannelId;
  onSelect: (id: ChannelId) => void;
}) {
  const refs = useRef<Map<ChannelId, HTMLButtonElement>>(new Map());
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const index = channels.findIndex((c) => c.id === selected);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = channels[(index + step + channels.length) % channels.length];
    if (!next) return;
    e.preventDefault();
    onSelect(next.id);
    refs.current.get(next.id)?.focus();
  };
  return (
    <div role="tablist" aria-label="Chat channels" onKeyDown={onKeyDown} style={rowStyle}>
      {channels.map((c) => {
        const isSelected = c.id === selected;
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(c.id, el);
              else refs.current.delete(c.id);
            }}
            onClick={() => onSelect(c.id)}
            style={socialTabStyle(isSelected)}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message log
// ---------------------------------------------------------------------------

export function ChatLog({
  messages,
  selfId,
  compact = false,
  reported,
  onBlock,
  onReport,
}: {
  messages: readonly ChatMessage[];
  selfId: string | null;
  compact?: boolean;
  reported: Readonly<Record<string, true>>;
  onBlock: (accountId: string) => void;
  onReport: (id: string, reason: ReportReason) => void;
}) {
  const ref = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const lastId = messages.length > 0 ? messages[messages.length - 1]?.id : "";

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [lastId, messages.length]);

  const onScroll = () => {
    const el = ref.current;
    if (el) following.current = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
  };

  return (
    <ol
      ref={ref}
      role="log"
      aria-live="polite"
      aria-label="Messages"
      onScroll={onScroll}
      style={logStyle(compact)}
    >
      {messages.length === 0 ? <li style={mutedStyle}>No messages yet. Say hello.</li> : null}
      {messages.map((msg) => (
        <ChatRow
          key={msg.id}
          msg={msg}
          own={selfId !== null && msg.from === selfId}
          reported={reported[msg.id] === true}
          onBlock={onBlock}
          onReport={onReport}
        />
      ))}
    </ol>
  );
}

function logStyle(compact: boolean): CSSProperties {
  return {
    listStyle: "none",
    margin: 0,
    padding: compact ? 6 : 8,
    background: SOCIAL_C.field,
    border: `1px solid ${SOCIAL_C.border}`,
    borderRadius: 8,
    overflowY: "auto",
    minHeight: compact ? 120 : 180,
    maxHeight: compact ? 200 : 340,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: compact ? 12 : 13,
    overflowWrap: "anywhere",
    minWidth: 0,
  };
}

export function ChatRow({
  msg,
  own,
  reported,
  onBlock,
  onReport,
}: {
  msg: ChatMessage;
  own: boolean;
  reported: boolean;
  onBlock: (accountId: string) => void;
  onReport: (id: string, reason: ReportReason) => void;
}) {
  const [menu, setMenu] = useState<"closed" | "open" | "report">("closed");
  const [reason, setReason] = useState<ReportReason>("spam");

  if (msg.system) {
    return <li style={{ ...mutedStyle, fontStyle: "italic" }}>{msg.text}</li>;
  }

  const rowLook: CSSProperties = {
    padding: "4px 6px",
    borderRadius: 6,
    background: own ? SOCIAL_C.own : "transparent",
    minWidth: 0,
  };

  return (
    <li data-own={own ? "true" : undefined} style={rowLook}>
      <div style={{ ...rowStyle, gap: 6 }}>
        <span style={{ color: own ? SOCIAL_C.goldBright : SOCIAL_C.text, fontWeight: 700 }}>
          {msg.name}
        </span>
        {msg.tag ? (
          <span style={{ color: SOCIAL_C.gold, fontSize: 11 }}>{`<${msg.tag}>`}</span>
        ) : null}
        <span style={{ ...mutedStyle, fontSize: 11 }}>{formatClock(msg.at)}</span>
        {!own ? (
          <button
            type="button"
            aria-label={`More actions for ${msg.name}`}
            aria-expanded={menu !== "closed"}
            onClick={() => setMenu(menu === "closed" ? "open" : "closed")}
            style={{
              ...socialButtonStyle(),
              minHeight: SOCIAL_TOUCH,
              padding: "0 8px",
              marginLeft: "auto",
            }}
          >
            More
          </button>
        ) : null}
      </div>
      <div style={{ color: SOCIAL_C.text }}>{msg.text}</div>
      {!own && reported ? (
        // Outside the menu: Send report closes the menu, and the reporter must still see this (QA wave B).
        <p role="status" style={{ ...okTextStyle, margin: "4px 0 0" }}>
          Report sent. Thank you.
        </p>
      ) : null}
      {!own && menu !== "closed" ? (
        <div
          role="group"
          aria-label={`Actions for ${msg.name}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMenu("closed");
          }}
          style={{ ...rowStyle, marginTop: 6 }}
        >
          <button
            type="button"
            onClick={() => {
              onBlock(msg.from);
              setMenu("closed");
            }}
            style={socialButtonStyle()}
          >
            {`Block ${msg.name}`}
          </button>
          {reported ? null : menu === "report" ? (
            <div style={{ ...rowStyle, width: "100%" }}>
              <label
                style={{
                  ...fieldLabelStyle,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  flex: "1 1 160px",
                  minWidth: 0,
                }}
              >
                Reason
                <select
                  value={reason}
                  onChange={(e) => setReason(parseReportReason(e.target.value))}
                  style={{ ...inputStyle, color: SOCIAL_C.text }}
                >
                  {REPORT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {reportReasonText(r)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  onReport(msg.id, reason);
                  setMenu("closed");
                }}
                style={socialButtonStyle({ primary: true })}
              >
                Send report
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setMenu("report")} style={socialButtonStyle()}>
              Report
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function ChatComposer({
  draft,
  onDraft,
  onSubmit,
  canSend,
  sending,
  status,
  mutedUntil,
  error,
  compact = false,
}: {
  draft: string;
  onDraft: (text: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  canSend: boolean;
  sending: boolean;
  status: ChatChannelView["status"];
  /** Set while muted (the mute notice replaces the placeholder). */
  mutedUntil: number | null;
  error: string | null;
  compact?: boolean;
}) {
  const over = draft.length > CHAT_MAX_LEN;
  const empty = draft.trim().length === 0;
  // While the handshake runs the chat is not "unavailable", just not there yet (QA wave B).
  const placeholder =
    status === "online"
      ? "Say something…"
      : status === "connecting"
        ? "Connecting to chat…"
        : "Chat is unavailable right now";
  return (
    <form
      onSubmit={onSubmit}
      aria-label="Send a message"
      style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}
    >
      {mutedUntil != null ? (
        <p role="status" style={errorTextStyle}>
          {`You are muted until ${formatClock(mutedUntil)}.`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={errorTextStyle}>
          {error}
        </p>
      ) : null}
      <div style={rowStyle}>
        <input
          type="text"
          aria-label="Chat message"
          aria-describedby="chat-counter"
          value={draft}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => onDraft(e.target.value)}
          style={{ ...inputStyle, flex: "1 1 160px", minWidth: 0, fontSize: compact ? 12 : 13 }}
        />
        <button
          type="submit"
          disabled={!canSend || sending || empty || over}
          style={socialButtonStyle({
            primary: true,
            disabled: !canSend || sending || empty || over,
          })}
        >
          Send
        </button>
      </div>
      <span
        id="chat-counter"
        style={{
          ...mutedStyle,
          textAlign: "right",
          color: over ? SOCIAL_C.danger : SOCIAL_C.muted,
        }}
      >
        {`${draft.length}/${CHAT_MAX_LEN}`}
      </span>
    </form>
  );
}
