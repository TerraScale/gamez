/**
 * Error-message normalisation for client telemetry (docs/design/admin-dashboard.md §9).
 * OWNER: T-telemetry. Pure.
 *
 * Delegates to the shared scrubTelemetryMessage (@gamez/protocol): URLs, e-mail
 * addresses, tokens/ids and digit runs are replaced and the result is cut to
 * 120 characters. The server scrubs again with the same function.
 */
import { scrubTelemetryMessage } from "@gamez/protocol";

const MAX_INPUT = 1000;

export function normaliseMessage(input: unknown): string {
  let text: string;
  if (typeof input === "string") text = input;
  else if (input instanceof Error) text = input.message;
  else if (typeof input === "number" || typeof input === "boolean") text = String(input);
  else text = "";
  return scrubTelemetryMessage(text.slice(0, MAX_INPUT));
}
