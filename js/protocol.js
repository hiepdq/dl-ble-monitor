/**
 * BLE framing of the datalogger "new protocol" (USING_NEW_BLE_APP_PROTOCOL).
 * Source of truth: 1.Firmware/Datalogger_FW/Core/Src/tl_np_ble.c, Inc/tl_np_ble.h, Inc/app_np_ble.h
 *
 * Single frame : AC | 00 | len | id | opLo opHi | payload[len]               | crcLo crcHi
 * Multi frame  : AC | 01 | len | id | opLo opHi | total(u32) cur(u32) chunk[len] | crcLo crcHi
 *                (len counts only the chunk, the 8 info bytes come on top)
 * CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF) over everything after the 0xAC.
 * id   : high nibble = receiver, low nibble = sender (datalogger 1, PC/app 2).
 * op   : low 12 bits = command, high 4 bits = reply type.
 */

export const FRAME_START = 0xAC;
export const TYPE_SINGLE = 0;
export const TYPE_MULTI = 1;

export const ID_DATALOGGER = 0x1;
export const ID_PC = 0x2;
/** Frames we send: to the datalogger, from the PC/app. */
export const ID_TO_DATALOGGER = (ID_DATALOGGER << 4) | ID_PC;   // 0x12

export const REPLY = Object.freeze({
  NONE: 0x0000,
  REQUIRED: 0x1000,
  DATA: 0x2000,
  ERROR: 0x3000,
  MULTI_ACK: 0x4000,
  MULTI_NACK: 0x5000,
  MULTI_END: 0x6000,
});

export const OP = Object.freeze({
  HANDSHAKE: 0x001,
  VERIFY_TIME: 0x002,
  MAX_PAYLOAD: 0x003,
  DATALOGGER_INFO: 0x004,
  PCBA_INFO: 0x005,
  PCBA_RUNNING: 0x006,
  PCBA_PROTECT: 0x007,
  HIST_ERROR: 0x00D,
  UPLOAD_TEMP: 0x01A,
  UPLOAD_SELF_VI: 0x01B,
  UPLOAD_BMS: 0x01C,
  UPLOAD_18V_BAT: 0x01D,
});

export const OP_NAME = Object.freeze(
  Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k])));

/* ------------------------------------------------------------------ CRC */
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) {
      c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    }
    t[i] = c & 0xFFFF;
  }
  return t;
})();

/** CRC16-CCITT-FALSE, same table as utility_function.c. */
export function crc16(bytes, start = 0, end = bytes.length) {
  let crc = 0xFFFF;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xFF]) & 0xFFFF;
  }
  return crc;
}

/* ------------------------------------------------------------------ encode */
/** Single frame. @param op full 16-bit opcode (command | reply type). */
export function buildFrame(op, data = [], id = ID_TO_DATALOGGER) {
  const len = data.length;
  if (len > 255) {
    throw new RangeError('single frame payload > 255');
  }
  const f = new Uint8Array(8 + len);
  f[0] = FRAME_START;
  f[1] = TYPE_SINGLE;
  f[2] = len;
  f[3] = id;
  f[4] = op & 0xFF;
  f[5] = (op >> 8) & 0xFF;
  f.set(data, 6);
  const crc = crc16(f, 1, 6 + len);
  f[6 + len] = crc & 0xFF;
  f[7 + len] = crc >> 8;
  return f;
}

/** Multi frame piece (used by the simulator and the tests). */
export function buildMultiFrame(op, total, current, chunk, id) {
  const len = chunk.length;
  const f = new Uint8Array(16 + len);
  f[0] = FRAME_START;
  f[1] = TYPE_MULTI;
  f[2] = len;
  f[3] = id;
  f[4] = op & 0xFF;
  f[5] = (op >> 8) & 0xFF;
  writeU32(f, 6, total);
  writeU32(f, 10, current);
  f.set(chunk, 14);
  const crc = crc16(f, 1, 14 + len);
  f[14 + len] = crc & 0xFF;
  f[15 + len] = crc >> 8;
  return f;
}

/** Request to the datalogger: command | REPLY.REQUIRED. */
export function request(cmd, data = []) {
  return buildFrame((cmd & 0x0FFF) | REPLY.REQUIRED, data);
}

/** Answer to a frame the datalogger pushed with REPLY.REQUIRED (Data[0] = 0: OK). */
export function ackPush(cmd) {
  return buildFrame((cmd & 0x0FFF) | REPLY.DATA, [0]);
}

/** Multi frame flow control (sent by the receiver): ACK = next piece, END = all received. */
export function multiControl(cmd, replyType) {
  return buildFrame((cmd & 0x0FFF) | replyType, []);
}

/* ------------------------------------------------------------------ decode */
/**
 * Stream parser: BLE notifications may cut or merge frames, so bytes are buffered
 * and frames are extracted when complete and their CRC matches.
 */
export class FrameParser {
  constructor() {
    this.buf = new Uint8Array(0);
    this.crcErrors = 0;
    this.dropped = 0;
  }

  reset() {
    this.buf = new Uint8Array(0);
  }

  /** @returns {Array<object>} decoded frames */
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    const b = merged;
    const out = [];
    let i = 0;

    while (i < b.length) {
      if (b[i] !== FRAME_START) {
        i++;
        this.dropped++;
        continue;
      }
      if (b.length - i < 3) {
        break;                                  // wait for type + len
      }
      const type = b[i + 1];
      if (type !== TYPE_SINGLE && type !== TYPE_MULTI) {
        i++;
        this.dropped++;
        continue;
      }
      const len = b[i + 2];
      const body = (type === TYPE_MULTI) ? len + 8 : len;
      const total = 6 + body + 2;
      if (b.length - i < total) {
        break;                                  // incomplete frame: wait for more bytes
      }
      const crcRx = b[i + total - 2] | (b[i + total - 1] << 8);
      if (crc16(b, i + 1, i + total - 2) !== crcRx) {
        this.crcErrors++;
        i++;                                    // resync on the next 0xAC
        continue;
      }
      out.push(decodeFrame(b.subarray(i, i + total)));
      i += total;
    }

    this.buf = b.slice(i);
    if (this.buf.length > 2048) {              // garbage guard
      this.dropped += this.buf.length;
      this.buf = new Uint8Array(0);
    }
    return out;
  }
}

function decodeFrame(raw) {
  const type = raw[1];
  const op = raw[4] | (raw[5] << 8);
  const f = {
    type,
    id: raw[3],
    op,
    cmd: op & 0x0FFF,
    reply: op & 0xF000,
    raw: raw.slice(),
  };
  if (type === TYPE_MULTI) {
    f.total = readU32(raw, 6);
    f.current = readU32(raw, 10);
    f.data = raw.slice(14, 14 + raw[2]);
  } else {
    f.data = raw.slice(6, 6 + raw[2]);
  }
  return f;
}

/**
 * Reassembles multi frames sent by the datalogger (Pack_Next_Multi_Frame).
 * feed() returns { reply: Uint8Array|null, frame: object|null }:
 *   reply : what to send back (ACK for the next piece, END after the last one, NACK on error)
 *   frame : the complete message once the last piece arrived (same shape as a single frame)
 */
export class MultiAssembler {
  constructor() {
    this.reset();
  }

  reset() {
    this.op = -1;
    this.expected = 1;
    this.total = 0;
    this.parts = [];
  }

  feed(f) {
    if (f.current === 1) {
      this.reset();
      this.op = f.op;
      this.id = f.id;
      this.total = f.total;
    }
    if (f.op !== this.op || f.current !== this.expected || f.total !== this.total) {
      return { reply: multiControl(f.cmd, REPLY.MULTI_NACK), frame: null };
    }
    this.parts.push(f.data);
    this.expected++;
    if (f.current < f.total) {
      return { reply: multiControl(f.cmd, REPLY.MULTI_ACK), frame: null };
    }
    const size = this.parts.reduce((n, p) => n + p.length, 0);
    const data = new Uint8Array(size);
    let off = 0;
    for (const p of this.parts) {
      data.set(p, off);
      off += p.length;
    }
    const frame = {
      type: TYPE_MULTI, id: this.id, op: this.op, cmd: this.op & 0x0FFF,
      reply: this.op & 0xF000, data, raw: null, pieces: this.total,
    };
    this.reset();
    return { reply: multiControl(frame.cmd, REPLY.MULTI_END), frame };
  }
}

/* ------------------------------------------------------------------ helpers */
export function readU16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

export function readS16(b, o) {
  const v = readU16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
}

export function readU32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function readS32(b, o) {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

export function writeU32(b, o, v) {
  b[o] = v & 0xFF;
  b[o + 1] = (v >>> 8) & 0xFF;
  b[o + 2] = (v >>> 16) & 0xFF;
  b[o + 3] = (v >>> 24) & 0xFF;
}

export function hex(bytes) {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
