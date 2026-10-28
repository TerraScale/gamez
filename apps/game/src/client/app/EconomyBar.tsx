/**
 * Picker economy bar (wave C, docs/design/wave-C.md §10.4): one 44 px button per
 * visible entry, and the notices bell with its unread count. The entries come
 * from visibleEntries() (absent APIs and flags off are already filtered out).
 */
import { entryItem, entryLabel, type EntryId, type ShellItem } from "./screens.ts";

export interface EconomyBarProps {
  entries: readonly EntryId[];
  /** Unread notices (the bell badge). */
  unread: number;
  onOpen: (item: ShellItem) => void;
}

const BELL_PATH =
  "M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z";

export function EconomyBar({ entries, unread, onOpen }: EconomyBarProps) {
  if (entries.length === 0) return null;
  return (
    <nav className="economy-bar" aria-label="Economy">
      {entries.map((id) => {
        if (id !== "notices") {
          return (
            <button
              key={id}
              type="button"
              className="economy-button"
              onClick={() => onOpen(entryItem(id))}
            >
              {entryLabel(id)}
            </button>
          );
        }
        const label = unread > 0 ? `Notices, ${unread} unread` : "Notices";
        return (
          <button
            key={id}
            type="button"
            className="economy-button economy-bell"
            aria-label={label}
            title={label}
            onClick={() => onOpen(entryItem(id))}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path d={BELL_PATH} fill="currentColor" />
            </svg>
            <span className="economy-label">Inbox</span>
            {unread > 0 ? (
              <span className="bell-badge" aria-hidden="true">
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
