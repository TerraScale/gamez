import { jsonCodec, type Codec } from "@gamez/protocol";

/**
 * The one wire codec used by both the client and the RelayDO. Switching the
 * wire format (e.g. to `binaryCodec`) is a change to this line only.
 *
 * Lives in src/shared/: pure code with no Workers or DOM APIs, imported by
 * the client, the Worker and tools/e2e.
 */
export const codec: Codec = jsonCodec;

/** WebSocket close code: the token is invalid, log in again (don't just reconnect). */
export const CLOSE_UNAUTHORIZED = 4401;
