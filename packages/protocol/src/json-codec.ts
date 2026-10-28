import type { ClientMessage, Codec, Frame, ServerMessage } from "./messages.ts";

const decoder = new TextDecoder();

function toText(frame: Frame | ArrayBuffer): string {
  return typeof frame === "string" ? frame : decoder.decode(frame);
}

/** Baseline codec. Readable and good enough until the wire-format benchmark picks a winner. */
export const jsonCodec: Codec = {
  name: "json",
  encodeClient: (msg) => JSON.stringify(msg),
  decodeClient: (frame) => JSON.parse(toText(frame)) as ClientMessage,
  encodeServer: (msg) => JSON.stringify(msg),
  decodeServer: (frame) => JSON.parse(toText(frame)) as ServerMessage,
};
