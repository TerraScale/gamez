/**
 * Instance connections for the app shell: one InstanceClient per mode,
 * reused until it is closed.
 */
import type { InstanceConnection, Session } from "@gamez/ui-host";
import { MODES } from "../../shared/catalog.ts";
import { clearSession, getSession } from "../session.ts";
import { loadedMode } from "./modes.ts";
import { InstanceClient } from "./connection.ts";

export { InstanceClient, instanceUrl, PING_MS, type InstanceClientOptions } from "./connection.ts";
export { Prediction, type PendingAction } from "./prediction.ts";

/** Returns connectInstance(mode) for ClientServices, starting from the app's session. */
export function instanceConnector(initial: Session): (mode: string) => InstanceConnection {
  let session: Session | null = initial;
  const open = new Map<string, InstanceConnection>();
  return (mode) => {
    const live = open.get(mode);
    if (live) return live;
    const loaded = loadedMode(mode, MODES);
    if (!loaded) throw new Error(`unknown instance mode "${mode}"`);
    const conn = new InstanceClient({
      mode,
      loaded,
      async session() {
        session ??= await getSession();
        return session;
      },
      onUnauthorized() {
        clearSession();
        session = null;
      },
      onClose() {
        if (open.get(mode) === conn) open.delete(mode);
      },
    });
    open.set(mode, conn);
    return conn;
  };
}
