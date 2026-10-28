/**
 * Worker route GET /ws/instance?token=…&mode=…: verifies the guest token
 * like /ws, checks the mode is in the catalog and forwards the upgrade to the
 * player's InstanceDO ("<mode>:<accountId>") near the client.
 */
import type { ModeSpec } from "@gamez/kernel";
import { GUEST_TOKEN_MAX_AGE_MS, verifyToken } from "../auth.ts";
import { INSTANCE_HEADERS, type Env } from "../contracts.ts";
import { relayLocation } from "../routing.ts";
import { CLOSE_UNAUTHORIZED } from "../../shared/codec.ts";
import { MODES } from "../../shared/catalog.ts";
import { findMode, instanceName } from "./modes.ts";

export const INSTANCE_PATH = "/ws/instance";

export async function connectInstance(
  request: Request,
  env: Pick<Env, "AUTH_SECRET" | "INSTANCE">,
  url: URL,
  modes: readonly ModeSpec[] = MODES,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const mode = findMode(url.searchParams.get("mode") ?? "", modes);
  if (!mode) return new Response("unknown mode", { status: 404 });
  const identity = await verifyToken(
    env.AUTH_SECRET,
    url.searchParams.get("token") ?? "",
    GUEST_TOKEN_MAX_AGE_MS,
  );
  if (!identity) return rejectSocket();

  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const continent = typeof cf?.continent === "string" ? cf.continent : "XX";
  const locationHint = relayLocation(continent, Number(cf?.longitude));
  const stub = env.INSTANCE.getByName(
    instanceName(mode.id, identity.accountId),
    locationHint ? { locationHint } : undefined,
  );

  // Identity travels in headers we set ourselves; anything the client sent is overwritten.
  const headers = new Headers(request.headers);
  headers.set(INSTANCE_HEADERS.accountId, identity.accountId);
  headers.set(INSTANCE_HEADERS.name, identity.name);
  headers.set(INSTANCE_HEADERS.mode, mode.id);
  return stub.fetch(new Request(request, { headers }));
}

/** Accepts the upgrade only to close with 4401, so the client knows to log in again. */
function rejectSocket(): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(CLOSE_UNAUTHORIZED, "unauthorized");
  return new Response(null, { status: 101, webSocket: client });
}
