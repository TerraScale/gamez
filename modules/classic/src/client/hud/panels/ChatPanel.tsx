/**
 * Panel "chat" (wave B, docs/design/wave-B.md §8.4). OWNER: T-classic-hud.
 * Wraps the shared ChatWindow (@gamez/ui-host) with api.platform. Channels: global, the classic
 * mode channel and the guild channel when the account is in a guild. Without api.platform the
 * panel shows an offline note.
 */
import { useEffect, useMemo, useState } from "react";
import { ChatWindow, type ChannelId, type GuildInfo, type PlatformServices } from "@gamez/ui-host";
import { PanelFrame, useHudLayout, type SlotProps } from "../common.tsx";
import { C } from "../styles.ts";

/** The account's guild (null when none, when the call fails or as a guest). Reloads on session change. */
export function useMyGuild(platform: PlatformServices | null): GuildInfo | null {
  const [guild, setGuild] = useState<GuildInfo | null>(null);
  useEffect(() => {
    if (!platform) return;
    let alive = true;
    const load = () => {
      platform.guilds.mine().then(
        (r) => {
          if (alive && r.ok) setGuild(r.value);
        },
        () => {},
      );
    };
    load();
    const off = platform.auth.onSessionChange(load);
    return () => {
      alive = false;
      off();
    };
  }, [platform]);
  return guild;
}

export function ChatPanel({ api }: SlotProps) {
  const platform = api.platform ?? null;
  const compact = useHudLayout(api) !== "desktop";
  const guild = useMyGuild(platform);
  const selfId = api.session?.accountId ?? null;
  const channels = useMemo(() => {
    const list: { id: ChannelId; label: string }[] = [
      { id: "global", label: "Global" },
      { id: "mode:classic", label: "Classic" },
    ];
    if (guild) list.push({ id: `guild:${guild.id}`, label: `Guild ${guild.tag}` });
    return list;
  }, [guild]);
  return (
    <PanelFrame api={api} id="chat" title="Chat" width={440}>
      {platform ? (
        <div style={{ height: compact ? "100%" : 460, minHeight: 240 }}>
          <ChatWindow chat={platform.chat} channels={channels} selfId={selfId} compact={compact} />
        </div>
      ) : (
        <p style={{ color: C.muted, margin: 0 }}>Offline: chat needs the game server.</p>
      )}
    </PanelFrame>
  );
}
