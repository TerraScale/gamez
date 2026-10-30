import {
  binaryCodec,
  jsonCodec,
  type ClientMessage,
  type Codec,
  type Frame,
  type ServerMessage,
} from "@gamez/protocol";

/**
 * The one presence wire codec, used by the client, the RelayDO and the tools
 * (e2e, loadtest). Switching the format is a change to this line only.
 *
 * Clients say which codec they speak in the presence URL (CODEC_QUERY). The
 * RelayDO answers each socket in the codec it announced; a socket that
 * announces nothing (a build from before the switch) gets JSON, which keeps
 * old tabs working for a version window. Once no JSON client is left, drop
 * legacyCodec and the fallback in codecByName.
 *
 * Lives in src/shared/: pure code with no Workers or DOM APIs, imported by
 * the client, the Worker and tools/e2e.
 */
export const codec: Codec = binaryCodec;

/** The format of pre-switch builds: JSON, with no codec announcement. */
export const legacyCodec: Codec = jsonCodec;

/** Query parameter that announces a client's codec. */
export const CODEC_PARAM = "codec";

/** The announcement a current client adds to its presence URL, e.g. `codec=binary`. */
export const CODEC_QUERY = `${CODEC_PARAM}=${codec.name}`;

/** The codec a socket speaks, given the name it announced; anything else is the legacy JSON format. */
export function codecByName(name: string | null | undefined): Codec {
  return name === codec.name ? codec : legacyCodec;
}

/**
 * Decodes a client message in the format it arrived in: a string frame is
 * JSON, bytes are the current codec. Accepting both keeps old clients working.
 */
export function decodeClientFrame(frame: Frame | ArrayBuffer): ClientMessage {
  return (typeof frame === "string" ? legacyCodec : codec).decodeClient(frame);
}

/** Decodes a server message in the format it arrived in (see decodeClientFrame). */
export function decodeServerFrame(frame: Frame | ArrayBuffer): ServerMessage {
  return (typeof frame === "string" ? legacyCodec : codec).decodeServer(frame);
}

/** WebSocket close code: the token is invalid, log in again (don't just reconnect). */
export const CLOSE_UNAUTHORIZED = 4401;
