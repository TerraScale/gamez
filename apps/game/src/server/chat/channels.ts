/**
 * Channel ids and their access rules (wave-B.md §5). Pure.
 *
 *   "global"            everyone signed in (guests included)
 *   "mode:<modeId>"     a catalog mode's channel
 *   "guild:<guildId>"   guild members only (the route checks AccountDO.guild())
 */

export type ChannelRef =
  | { kind: "global"; channel: "global" }
  | { kind: "mode"; channel: string; modeId: string }
  | { kind: "guild"; channel: string; guildId: string };

export const GLOBAL_CHANNEL = "global";

const GUILD_ID = /^[a-z0-9-]{3,24}$/;

/** The ref of a channel id, or null when it is not a channel that exists. */
export function parseChannel(channel: string, modes: readonly { id: string }[]): ChannelRef | null {
  if (channel === GLOBAL_CHANNEL) return { kind: "global", channel: GLOBAL_CHANNEL };
  if (channel.startsWith("mode:")) {
    const modeId = channel.slice(5);
    if (!modes.some((m) => m.id === modeId)) return null;
    return { kind: "mode", channel, modeId };
  }
  if (channel.startsWith("guild:")) {
    const guildId = channel.slice(6);
    if (!GUILD_ID.test(guildId)) return null;
    return { kind: "guild", channel, guildId };
  }
  return null;
}
