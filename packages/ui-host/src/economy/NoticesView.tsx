/**
 * Inbox of account notices (trade invites, sales, outbids, rent, arena, passes).
 * Newest first; unread items carry a marker; linkable notices get an Open
 * button that the host turns into a screen (trade, market, shop, arena).
 */
import type { Notice } from "@gamez/protocol";
import type { NoticesViewProps } from "./index.ts";
import {
  type LoadState,
  linkOf,
  loadResult,
  markAllRead,
  newestFirst,
  unreadCount,
} from "./parts/flows.ts";
import { useAction, useReload } from "./parts/hooks.ts";
import { formatWhen } from "./parts/text.ts";
import { Banner, StateNote, actionsStyle, rowBox } from "./parts/ui.tsx";
import {
  SOCIAL_C,
  headingStyle,
  mutedStyle,
  sheetStyle,
  socialButtonStyle,
} from "../social/styles.ts";

export interface NoticesBodyProps {
  state: LoadState<{ notices: Notice[]; unread: number }> | undefined;
  canOpen: boolean;
  busy: boolean;
  error: string | null;
  onOpen: (notice: Notice) => void;
  onMarkAll: () => void;
  onRetry: () => void;
}

export function NoticesBody({
  state,
  canOpen,
  busy,
  error,
  onOpen,
  onMarkAll,
  onRetry,
}: NoticesBodyProps) {
  const notices = state?.status === "ready" ? newestFirst(state.value.notices) : [];
  const unread = state?.status === "ready" ? unreadCount(state.value.notices) : 0;
  return (
    <section aria-label="Notices" style={{ ...sheetStyle, padding: 12 }}>
      <div style={actionsStyle}>
        <h3 style={{ ...headingStyle, flex: "1 1 auto" }}>
          Notices{unread > 0 ? ` (${unread} new)` : ""}
        </h3>
        {unread > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={onMarkAll}
            style={socialButtonStyle({ disabled: busy })}
          >
            Mark all read
          </button>
        ) : null}
      </div>
      {error ? <Banner tone="error">{error}</Banner> : null}

      {state === undefined || state.status === "loading" ? (
        <StateNote kind="loading" message="Loading notices…" />
      ) : state.status === "error" ? (
        <StateNote kind="error" message={state.message} onRetry={onRetry} />
      ) : notices.length === 0 ? (
        <StateNote kind="empty" message="No notices yet." />
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            minWidth: 0,
          }}
        >
          {notices.map((notice) => {
            const linked = canOpen && linkOf(notice) !== null;
            return (
              <li key={notice.id} style={{ ...rowBox, alignItems: "center" }}>
                <span
                  aria-label={notice.read ? "Read" : "Unread"}
                  title={notice.read ? "Read" : "Unread"}
                  style={{
                    flex: "0 0 auto",
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: notice.read ? "transparent" : SOCIAL_C.goldBright,
                    border: `1px solid ${SOCIAL_C.gold}`,
                  }}
                />
                <div
                  style={{
                    minWidth: 0,
                    flex: "1 1 160px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      color: notice.read ? SOCIAL_C.text : SOCIAL_C.goldBright,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {notice.text}
                  </span>
                  <span style={mutedStyle}>{formatWhen(notice.at)}</span>
                </div>
                {linked ? (
                  <button
                    type="button"
                    aria-label={`Open: ${notice.text}`}
                    onClick={() => onOpen(notice)}
                    style={socialButtonStyle()}
                  >
                    Open
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function NoticesView({ vault, onOpen }: NoticesViewProps) {
  const notices = useReload(() => loadResult(() => vault.notices(null)), "notices");
  const action = useAction();
  const loaded = notices.state?.status === "ready" ? notices.state.value.notices : null;
  return (
    <NoticesBody
      state={notices.state}
      canOpen={!!onOpen}
      busy={action.busy}
      error={action.error}
      onOpen={(notice) => onOpen?.(notice)}
      onMarkAll={() => {
        if (!loaded) return;
        void action
          .run(() => markAllRead(vault, loaded))
          .then((res) => {
            if (res.ok) notices.reload();
          });
      }}
      onRetry={notices.reload}
    />
  );
}
