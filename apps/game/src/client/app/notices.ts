/**
 * Plain-words notices for the app shell (toasts): OAuth return fragments and
 * API error codes (docs/design/wave-B.md §3, §8.2). Pure, no DOM.
 */
import { DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, PASSWORD_MAX, PASSWORD_MIN } from "@gamez/protocol";
import type { ApiResult } from "@gamez/ui-host";
import type { AuthFragmentResult, GuestSession } from "../session.ts";

export type NoticeTone = "info" | "ok" | "error";

/** A button on a toast (e.g. "Open" for a trade invite). */
export interface NoticeAction {
  label: string;
  run(): void;
}

export interface Notice {
  tone: NoticeTone;
  text: string;
  action?: NoticeAction;
}

/** Result of consumeAuthFragment() (session.ts). */
export type AuthFragment = AuthFragmentResult | null;

const ERROR_TEXT: Readonly<Record<string, string>> = {
  access_denied: "Sign-in was cancelled.",
  bad_request: "That request did not make sense. Try again.",
  weak_password: `Passwords need ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`,
  bad_email: "That email address does not look right.",
  bad_name: `Display names need ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters.`,
  email_taken: "That email is already registered. Try signing in.",
  identity_taken: "That sign-in is already linked to another account.",
  bad_credentials: "Wrong email or password.",
  locked: "Too many attempts. Wait a few minutes and try again.",
  provider_disabled: "That sign-in method is not available right now.",
  oauth_failed: "Sign-in did not complete. Try again.",
  oauth_expired: "Sign-in expired. Try again.",
  unauthorized: "Your session ended. Sign in again.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  not_found: "That could not be found.",
  name_taken: "That name is already taken.",
  already_in_guild: "You are already in a guild.",
  not_in_guild: "You are not in a guild.",
  full: "That guild is full.",
  closed: "That guild is invite only.",
  forbidden: "You are not allowed to do that.",
  guest_forbidden: "Save your progress first to join a guild.",
};

/** Plain words for an error code; unknown codes get a generic line (the raw code is never shown). */
export function describeError(code: string): string {
  return ERROR_TEXT[code] ?? "Something went wrong. Try again.";
}

/**
 * Handles the OAuth return at boot. A session replaces the stored one
 * (`setSession`); either outcome becomes a toast. Returns null when the page
 * was not an OAuth return, and for a link code (see applyOAuthLink).
 * consumeAuthFragment only yields a session for a flow this tab started.
 */
export function applyAuthFragment(
  fragment: AuthFragment,
  setSession: (s: GuestSession) => void,
): Notice | null {
  if (fragment === null || "link" in fragment) return null;
  if ("error" in fragment) return { tone: "error", text: describeError(fragment.error) };
  setSession(fragment.session);
  return { tone: "ok", text: `Signed in as ${fragment.session.name}.` };
}

/**
 * Finishes a link return (`#oauth_link=<code>`, ADR 0007 R3): redeems the
 * code with the current session as the bearer and stores the session it
 * answers (same account, now registered). Failures keep `current`.
 */
export async function applyOAuthLink(
  code: string,
  current: GuestSession,
  redeem: (code: string, token: string) => Promise<ApiResult<GuestSession>>,
  setSession: (s: GuestSession) => void,
): Promise<{ session: GuestSession; notice: Notice }> {
  let res: ApiResult<GuestSession>;
  try {
    res = await redeem(code, current.token);
  } catch {
    res = { ok: false, code: "network", message: "network" };
  }
  if (!res.ok) {
    return { session: current, notice: { tone: "error", text: describeError(res.code) } };
  }
  setSession(res.value);
  return { session: res.value, notice: { tone: "ok", text: `Login linked to ${res.value.name}.` } };
}
