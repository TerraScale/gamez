/**
 * Presence connections for pose worlds (wave-B.md §7): /ws?token&world=<id>.
 * OWNER: T-presence. services.joinPresence = presenceConnector(session).
 */
import type { PresenceConnection, Session } from "@gamez/ui-host";
import { PresenceClient, presenceUrl } from "./connection.ts";

export { PresenceClient, presenceUrl } from "./connection.ts";

/** Builds a presence connection per world; the token is read from the session at each connect. */
export function presenceConnector(
  session: () => Session,
): ((world: string) => PresenceConnection) | undefined {
  return (world) =>
    new PresenceClient(world, async () =>
      presenceUrl(location.host, location.protocol === "https:", session().token, world),
    );
}
