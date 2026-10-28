import type { ModeInfo, AccountView } from "@gamez/protocol";
import type { PlatformServices, Session } from "@gamez/ui-host";
import { AccountChip } from "./AccountChip.tsx";
import { ChatDock } from "./ChatDock.tsx";
import { EconomyBar } from "./EconomyBar.tsx";
import { SocialBar } from "./SocialBar.tsx";
import type { EntryId, ShellItem } from "./screens.ts";

export interface ModePickerProps {
  session: Session;
  modes: readonly ModeInfo[];
  /** True when this client has a view for the mode. */
  isAvailable: (modeId: string) => boolean;
  onPick: (mode: ModeInfo) => void;
  /** Absent = offline host: no account chip actions, leaderboards, guilds or chat. */
  platform?: PlatformServices;
  /** Current account (null while loading). */
  account: AccountView | null;
  onOpenAccount: () => void;
  onOpenLeaderboards: () => void;
  onOpenGuild: () => void;
  /** Wave C economy bar: the visible entries, the unread count and where a click goes. Absent = no bar. */
  economy?: {
    entries: readonly EntryId[];
    unread: number;
    onOpen: (item: ShellItem) => void;
  };
}

/** Full-width mode list with large touch targets; usable down to 375 px. */
export function ModePicker({
  session,
  modes,
  isAvailable,
  onPick,
  platform,
  account,
  onOpenAccount,
  onOpenLeaderboards,
  onOpenGuild,
  economy,
}: ModePickerProps) {
  const online = platform !== undefined;
  return (
    <main className="picker">
      <header className="picker-header">
        <div className="picker-top">
          <h1>gamez</h1>
          <AccountChip session={session} account={account} online={online} onOpen={onOpenAccount} />
        </div>
        <p className="picker-who">Playing as {session.name}</p>
      </header>
      {online ? (
        <SocialBar
          guildTag={account?.guildTag ?? null}
          onLeaderboards={onOpenLeaderboards}
          onGuild={onOpenGuild}
        />
      ) : null}
      {economy ? (
        <EconomyBar entries={economy.entries} unread={economy.unread} onOpen={economy.onOpen} />
      ) : null}
      <h2 className="picker-title">Choose a mode</h2>
      <ul className="mode-list">
        {modes.map((mode) => {
          const available = isAvailable(mode.id);
          return (
            <li key={mode.id}>
              <button
                type="button"
                className="mode-card"
                disabled={!available}
                onClick={() => onPick(mode)}
              >
                <span className="mode-name">{mode.name}</span>
                <span className="mode-desc">{mode.description}</span>
                {available ? null : <span className="mode-badge">Not available yet</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {platform ? (
        <ChatDock
          chat={platform.chat}
          guildId={account?.guildId ?? null}
          selfId={account?.accountId ?? null}
        />
      ) : null}
    </main>
  );
}
