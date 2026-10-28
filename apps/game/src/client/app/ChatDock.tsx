/**
 * Chat dock at the bottom of the picker: collapsed by default (a 48 px bar),
 * expanded it shows ChatWindow with the global channel and, in a guild, the
 * guild channel. The socket only opens while expanded.
 */
import { useState } from "react";
import { ChatWindow, type ChatApi } from "@gamez/ui-host";

export interface ChatDockProps {
  chat: ChatApi;
  guildId: string | null;
  selfId: string | null;
}

export function channelsFor(guildId: string | null): { id: string; label: string }[] {
  const channels = [{ id: "global", label: "Global" }];
  if (guildId) channels.push({ id: `guild:${guildId}`, label: "Guild" });
  return channels;
}

export function ChatDock({ chat, guildId, selfId }: ChatDockProps) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="chat-dock chat-dock-collapsed">
        <button
          type="button"
          className="chat-toggle"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          Chat
        </button>
      </div>
    );
  }
  return (
    <div className="chat-dock chat-dock-open">
      <ChatWindow
        key={guildId ?? "none"}
        chat={chat}
        channels={channelsFor(guildId)}
        selfId={selfId}
        compact
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
