import type {
  ClientMessage,
  Codec,
  EntityKind,
  EntityState,
  Frame,
  ServerMessage,
  TilePos,
} from "./messages.ts";

/**
 * Compact binary wire format. Each frame is a 1-byte message tag followed by
 * the fields in declaration order. Counts and string byte lengths are uvarint,
 * tile coordinates are uint16, seq is uint32, times and speed are float64, and
 * entity kind is one byte. Multi-byte numbers are little-endian.
 *
 * Format v2 (wave B): every entity ends with a flags byte whose bit 0 says an
 * optional tag string follows. A pose client message (tag 4) carries a flags
 * byte too: bit 0 = appearance string follows, bit 1 = tag string follows.
 * Unknown flag bits are rejected, so a newer field can never be misread.
 */

const CLIENT_TAG = { hello: 1, moveTo: 2, ping: 3, pose: 4 } as const;
const ENTITY_FLAG_TAG = 0x01;
const POSE_FLAG_APPEARANCE = 0x01;
const POSE_FLAG_TAG = 0x02;
const SERVER_TAG = { welcome: 1, delta: 2, pong: 3, error: 4 } as const;

const KIND_CODE: Record<EntityKind, number> = { player: 0, ghost: 1, shopkeeper: 2 };
const KINDS: readonly EntityKind[] = ["player", "ghost", "shopkeeper"];

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Append-only buffer that doubles when full. */
class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.reserve(1);
    this.view.setUint8(this.pos++, v);
  }

  u16(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new RangeError(`binary codec: ${v} does not fit in uint16`);
    }
    this.reserve(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  u32(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
      throw new RangeError(`binary codec: ${v} does not fit in uint32`);
    }
    this.reserve(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  f64(v: number): void {
    this.reserve(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  uvarint(v: number): void {
    let rest = v;
    while (rest >= 0x80) {
      this.u8((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.u8(rest);
  }

  string(s: string): void {
    const bytes = encoder.encode(s);
    this.uvarint(bytes.length);
    this.reserve(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  tile(p: TilePos): void {
    this.u16(p.x);
    this.u16(p.y);
  }

  entity(e: EntityState): void {
    this.string(e.id);
    this.u8(KIND_CODE[e.kind]);
    this.string(e.name);
    this.string(e.appearance);
    this.tile(e.pos);
    this.uvarint(e.path.length);
    for (const step of e.path) this.tile(step);
    this.f64(e.pathStartedAt);
    this.f64(e.speed);
    this.u8(e.tag === undefined ? 0 : ENTITY_FLAG_TAG);
    if (e.tag !== undefined) this.string(e.tag);
  }

  entities(list: EntityState[]): void {
    this.uvarint(list.length);
    for (const e of list) this.entity(e);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

/** Cursor over a frame. Every read is bounds-checked so truncated input throws. */
class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(frame: Frame | ArrayBuffer) {
    if (typeof frame === "string") {
      throw new Error("binary codec: expected a binary frame, got a string");
    }
    this.bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  private take(n: number): number {
    if (this.pos + n > this.bytes.length) {
      throw new Error(
        `binary codec: truncated frame (need ${n} bytes at offset ${this.pos}, frame has ${this.bytes.length})`,
      );
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }

  uvarint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.u8();
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
      scale *= 0x80;
    }
    throw new Error("binary codec: malformed varint");
  }

  /** Reads an element count. Every element takes at least one byte, so a larger count is corrupt. */
  count(): number {
    const n = this.uvarint();
    if (n > this.bytes.length - this.pos) {
      throw new Error(`binary codec: truncated frame (count ${n} exceeds remaining bytes)`);
    }
    return n;
  }

  string(): string {
    const len = this.uvarint();
    const at = this.take(len);
    return decoder.decode(this.bytes.subarray(at, at + len));
  }

  tile(): TilePos {
    return { x: this.u16(), y: this.u16() };
  }

  entity(): EntityState {
    const id = this.string();
    const kindCode = this.u8();
    const kind = KINDS[kindCode];
    if (kind === undefined) throw new Error(`binary codec: unknown entity kind ${kindCode}`);
    const state: EntityState = {
      id,
      kind,
      name: this.string(),
      appearance: this.string(),
      pos: this.tile(),
      path: Array.from({ length: this.count() }, () => this.tile()),
      pathStartedAt: this.f64(),
      speed: this.f64(),
    };
    const flags = this.u8();
    if (flags & ~ENTITY_FLAG_TAG) throw new Error(`binary codec: unknown entity flags ${flags}`);
    if (flags & ENTITY_FLAG_TAG) state.tag = this.string();
    return state;
  }

  entities(): EntityState[] {
    return Array.from({ length: this.count() }, () => this.entity());
  }

  /** Throws if bytes are left over, which means the frame and the decoder disagree. */
  done(): void {
    const left = this.bytes.length - this.pos;
    if (left !== 0) throw new Error(`binary codec: ${left} trailing bytes after message`);
  }
}

function encodeClient(msg: ClientMessage): Uint8Array {
  const w = new Writer();
  switch (msg.t) {
    case "hello":
      w.u8(CLIENT_TAG.hello);
      w.string(msg.token);
      break;
    case "moveTo":
      w.u8(CLIENT_TAG.moveTo);
      w.tile(msg.target);
      break;
    case "ping":
      w.u8(CLIENT_TAG.ping);
      w.f64(msg.clientTime);
      break;
    case "pose":
      w.u8(CLIENT_TAG.pose);
      w.tile(msg.pos);
      w.uvarint(msg.path.length);
      for (const step of msg.path) w.tile(step);
      w.f64(msg.speed);
      w.u8(
        (msg.appearance === undefined ? 0 : POSE_FLAG_APPEARANCE) |
          (msg.tag === undefined ? 0 : POSE_FLAG_TAG),
      );
      if (msg.appearance !== undefined) w.string(msg.appearance);
      if (msg.tag !== undefined) w.string(msg.tag);
      break;
    default:
      throw new Error(`binary codec: unknown client message ${(msg as { t: string }).t}`);
  }
  return w.finish();
}

function decodeClient(frame: Frame | ArrayBuffer): ClientMessage {
  const r = new Reader(frame);
  const tag = r.u8();
  let msg: ClientMessage;
  switch (tag) {
    case CLIENT_TAG.hello:
      msg = { t: "hello", token: r.string() };
      break;
    case CLIENT_TAG.moveTo:
      msg = { t: "moveTo", target: r.tile() };
      break;
    case CLIENT_TAG.ping:
      msg = { t: "ping", clientTime: r.f64() };
      break;
    case CLIENT_TAG.pose: {
      const pos = r.tile();
      const path = Array.from({ length: r.count() }, () => r.tile());
      const speed = r.f64();
      const flags = r.u8();
      if (flags & ~(POSE_FLAG_APPEARANCE | POSE_FLAG_TAG)) {
        throw new Error(`binary codec: unknown pose flags ${flags}`);
      }
      msg = { t: "pose", pos, path, speed };
      if (flags & POSE_FLAG_APPEARANCE) msg.appearance = r.string();
      if (flags & POSE_FLAG_TAG) msg.tag = r.string();
      break;
    }
    default:
      throw new Error(`binary codec: unknown client message tag ${tag}`);
  }
  r.done();
  return msg;
}

function encodeServer(msg: ServerMessage): Uint8Array {
  const w = new Writer();
  switch (msg.t) {
    case "welcome":
      w.u8(SERVER_TAG.welcome);
      w.string(msg.selfId);
      w.string(msg.chunkId);
      w.u32(msg.seq);
      w.f64(msg.serverTime);
      w.entities(msg.entities);
      break;
    case "delta":
      w.u8(SERVER_TAG.delta);
      w.string(msg.chunkId);
      w.u32(msg.seq);
      w.entities(msg.upserts);
      w.uvarint(msg.removes.length);
      for (const id of msg.removes) w.string(id);
      break;
    case "pong":
      w.u8(SERVER_TAG.pong);
      w.f64(msg.clientTime);
      w.f64(msg.serverTime);
      break;
    case "error":
      w.u8(SERVER_TAG.error);
      w.string(msg.code);
      w.string(msg.message);
      break;
    default:
      throw new Error(`binary codec: unknown server message ${(msg as { t: string }).t}`);
  }
  return w.finish();
}

function decodeServer(frame: Frame | ArrayBuffer): ServerMessage {
  const r = new Reader(frame);
  const tag = r.u8();
  let msg: ServerMessage;
  switch (tag) {
    case SERVER_TAG.welcome:
      msg = {
        t: "welcome",
        selfId: r.string(),
        chunkId: r.string(),
        seq: r.u32(),
        serverTime: r.f64(),
        entities: r.entities(),
      };
      break;
    case SERVER_TAG.delta:
      msg = {
        t: "delta",
        chunkId: r.string(),
        seq: r.u32(),
        upserts: r.entities(),
        removes: Array.from({ length: r.count() }, () => r.string()),
      };
      break;
    case SERVER_TAG.pong:
      msg = { t: "pong", clientTime: r.f64(), serverTime: r.f64() };
      break;
    case SERVER_TAG.error:
      msg = { t: "error", code: r.string(), message: r.string() };
      break;
    default:
      throw new Error(`binary codec: unknown server message tag ${tag}`);
  }
  r.done();
  return msg;
}

/** Binary codec: same messages as jsonCodec, typically several times smaller on entity-heavy frames. */
export const binaryCodec: Codec = {
  name: "binary",
  encodeClient,
  decodeClient,
  encodeServer,
  decodeServer,
};
