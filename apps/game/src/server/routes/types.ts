/** Route handler contract for the Worker's fetch (wave B, routes/index.ts). */
import type { Env } from "../contracts.ts";

export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  ctx: ExecutionContext;
}

/** Answers a request it owns, or returns null to let the next route try. */
export type RouteHandler = (c: RouteContext) => Promise<Response | null> | Response | null;
