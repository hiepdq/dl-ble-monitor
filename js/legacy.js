/**
 * Legacy session: the 20-byte poll protocol of the old APK. It is the only BLE protocol of the
 * Debugger FW V4.x (1.Firmware/Debugger_FW/Core/Src/app_ble.c, BLE_Task state TAKE_COMMAND);
 * the datalogger FW V5.x still answers it next to the new protocol.
 *
 * Request, 20 bytes: [targetId, cmd, 0 x11, yy, MM, dd, hh, mm, ss, checksum]
 *   checksum = ~sum(bytes 0..18) + 1 (ntech_calculate_checksum).
 *   Bytes 13..18 set the datalogger RTC on the first valid frame after its boot; zeros leave it.
 * Answer, 68 bytes: [0xAA, start, 32 x u16 LE registers, status, checksum of bytes 1..66]
 *   status: bit0 tool bus OK, bit1 BLE OK, bit2 tool boot mode, bit3 TF card in, bit4 TF logging.
 *   The datalogger overwrites registers 0xB1..0xB7: 0xB1 low byte = target id polled on the tool
 *   bus, 0xB2 = FW date - 20230000, 0xB4..0xB7 low bytes = historical error code (u32, LSB first).
 *
 * READ_REG (0x03) ignores start / count: the datalogger walks blocks 0, 32 .. 224 twice, then only
 * answers block 32 (running registers). The walk restarts on REFRESH_ALL (0x5A), on a new target
 * id, or after 1 s without frames.
 * The tool bus is polled for the target id of the last queued command only, and READ_REG is not
 * queued: selecting a PCBA therefore sends REFRESH_ALL with its target id.
 * The datalogger reads one request per UART idle and answers it before reading again, so the
 * requests go out one at a time, each after the previous answer (or its timeout).
 *
 * Read only: REFRESH_ALL only makes the datalogger re-read the tool registers.
 */
import { hex, readU16 } from './protocol.js';
import { MAX_PCBAS, REG, mapIdToTargetId } from './decode.js';
import { emptyModel } from './session.js';

export const LEGACY_CMD = Object.freeze({ READ_REG: 0x03, REFRESH_ALL: 0x5A });
const CMD_NAME = { 0x03: 'READ_REG', 0x5A: 'REFRESH_ALL' };

const REQ_LEN = 20;
const ANS_LEN = 68;
const ANS_START = 0xAA;
const ANS_REGS = 32;
const STATUS_INDEX = 66;

const REG_BUS_TARGET = 0xB1;
const REG_FW_DATE = 0xB2;
const REG_HIST_ERROR = 0xB4;           // 0xB4..0xB7
const FW_YEAR_BASE = 20230000;         // Debugger_FW app.h

const POLL_GAP_MS = 150;
const ANSWER_TIMEOUT_MS = 1500;
const START_TRIES = 3;
const LOG_MAX = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ntech_calculate_checksum over bytes[start..end): ~sum + 1 = two's complement of the byte sum. */
export function legacyChecksum(bytes, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum = (sum + bytes[i]) & 0xFF;
  }
  return (-sum) & 0xFF;
}

/** 20-byte request; `time` (Date or null) fills the RTC bytes 13..18. */
export function legacyRequest(targetId, cmd, time = null) {
  const f = new Uint8Array(REQ_LEN);
  f[0] = targetId;
  f[1] = cmd;
  if (time) {
    f[13] = time.getFullYear() % 100;
    f[14] = time.getMonth() + 1;
    f[15] = time.getDate();
    f[16] = time.getHours();
    f[17] = time.getMinutes();
    f[18] = time.getSeconds();
  }
  f[19] = legacyChecksum(f, 0, REQ_LEN - 1);
  return f;
}

/** Reassembles 68-byte answers from BLE notifications (20 bytes each at the default MTU). */
export class LegacyParser {
  constructor() {
    this.buf = [];
    this.errors = 0;
  }

  reset() {
    this.buf = [];
  }

  push(bytes) {
    const out = [];
    for (const b of bytes) {
      this.buf.push(b);
    }
    while (this.buf.length) {
      if (this.buf[0] !== ANS_START) {
        this.buf.shift();
        continue;
      }
      if (this.buf.length < ANS_LEN) {
        break;
      }
      const f = Uint8Array.from(this.buf.slice(0, ANS_LEN));
      // register answers always start on a 32-register block: rejects 0xAA inside the data
      if (f[1] % ANS_REGS === 0 && legacyChecksum(f, 1, ANS_LEN - 1) === f[ANS_LEN - 1]) {
        out.push(f);
        this.buf.splice(0, ANS_LEN);
      } else {
        this.errors++;
        this.buf.shift();              // resync on the next 0xAA
      }
    }
    return out;
  }
}

/** Decodes one answer: register block, status byte and the registers the datalogger overwrites. */
export function decodeLegacyAnswer(f) {
  const start = f[1];
  const values = [];
  for (let i = 0; i < ANS_REGS; i++) {
    values.push(readU16(f, 2 + 2 * i));
  }
  const at = (reg) => (reg >= start && reg < start + ANS_REGS ? reg - start : -1);
  const res = { start, values, status: f[STATUS_INDEX] };
  if (at(REG_BUS_TARGET) >= 0) {
    res.busTargetId = values[at(REG_BUS_TARGET)] & 0xFF;
  }
  if (at(REG_FW_DATE) >= 0) {
    res.fwDate = FW_YEAR_BASE + values[at(REG_FW_DATE)];
  }
  if (at(REG_HIST_ERROR) >= 0 && at(REG_HIST_ERROR + 3) >= 0) {
    const b = [0, 1, 2, 3].map((k) => values[at(REG_HIST_ERROR + k)] & 0xFF);
    res.hist = { code: (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0, bytes: b };
  }
  return res;
}

/** Map id of a tool bus target id (Calc_PCBA_TgtID_To_MapID). */
function targetIdToMapId(id) {
  const m = id === 0x01 ? 0 : id - 0xA0;
  return m >= 0 && m < MAX_PCBAS ? m : 0;
}

/** Same interface as Session (model, start / stop / dispose, 'update' / 'log' events) plus select(). */
export class LegacySession extends EventTarget {
  constructor(transport, { syncTime = false } = {}) {
    super();
    this.legacy = true;
    this.t = transport;
    this.syncTime = syncTime;
    this.parser = new LegacyParser();
    this.model = emptyModel();
    this.model.legacy = { status: null, fwDate: null, busTargetId: null, misses: 0 };
    this.log = [];
    this.running = false;
    this.target = 0x01;
    this.nextTarget = null;
    this.waiter = null;
    this.onData = (e) => this.rxBytes(e.detail);
    this.t.addEventListener('data', this.onData);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  dispose() {
    this.stop();
    this.t.removeEventListener('data', this.onData);
  }

  /* ------------------------------------------------------------------ start / stop */
  async start() {
    this.parser.reset();
    this.running = true;
    await this.ask(LEGACY_CMD.REFRESH_ALL, START_TRIES);
    this.changed();
    this.poll();
  }

  stop() {
    this.running = false;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new Error('session stopped'));
      this.waiter = null;
    }
  }

  /** Switches the polled PCBA; applied before the next request. */
  select(mapId) {
    const id = mapIdToTargetId(mapId);
    if (id !== this.target) {
      this.nextTarget = id;
    }
  }

  async poll() {
    while (this.running) {
      let cmd = LEGACY_CMD.READ_REG;
      if (this.nextTarget != null) {
        this.target = this.nextTarget;
        this.nextTarget = null;
        cmd = LEGACY_CMD.REFRESH_ALL;
      }
      try {
        await this.ask(cmd, 1);
        this.model.legacy.misses = 0;
      } catch (err) {
        if (!this.running) {
          return;
        }
        this.model.legacy.misses++;
        this.addLog('err', err.message);
        this.changed();
      }
      await sleep(POLL_GAP_MS);
    }
  }

  /* ------------------------------------------------------------------ tx */
  async send(bytes) {
    this.model.stats.tx++;
    this.addLog('tx', hex(bytes));
    await this.t.write(bytes);
  }

  /** Sends one request and waits for the next valid answer (retries on timeout). */
  async ask(cmd, tries) {
    let lastErr;
    for (let i = 0; i < tries && this.running; i++) {
      this.parser.reset();             // a late answer of a timed out request must not count
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new Error(`no answer to ${CMD_NAME[cmd]} (0x${cmd.toString(16).toUpperCase()})`));
        }, ANSWER_TIMEOUT_MS);
        this.waiter = { resolve, reject, timer };
      });
      try {
        await this.send(legacyRequest(this.target, cmd, this.syncTime ? new Date() : null));
        return await answer;
      } catch (err) {
        if (this.waiter) {
          clearTimeout(this.waiter.timer);
          this.waiter = null;
        }
        lastErr = err;
      }
    }
    throw lastErr || new Error('session stopped');
  }

  /* ------------------------------------------------------------------ rx */
  rxBytes(bytes) {
    const before = this.parser.errors;
    for (const f of this.parser.push(bytes)) {
      this.addLog('rx', hex(f));
      this.apply(f);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(f);
      }
    }
    if (this.parser.errors !== before) {
      this.model.stats.crc += this.parser.errors - before;
      this.addLog('err', `checksum error (${this.model.stats.crc})`);
    }
  }

  /** The answer holds the registers of the requested target (Copy_PCBA_Register_Value_To_TxBuff). */
  apply(f) {
    const m = this.model;
    const now = Date.now();
    const a = decodeLegacyAnswer(f);
    const mapId = targetIdToMapId(this.target);
    const p = m.pcba[mapId];
    a.values.forEach((v, i) => {
      const reg = a.start + i;
      if (reg < 256 && (reg < REG_BUS_TARGET || reg > REG_HIST_ERROR + 3)) {
        p.regs[reg] = v;
      }
    });
    if (a.start <= REG.PCBA_NUM) {
      p.seen.info = now;
    }
    if (a.start <= REG.MOTOR_SM && a.start + ANS_REGS > REG.MOTOR_SM) {
      p.seen.run = now;
    }
    if (a.start + ANS_REGS > REG.EN_CONTROL && a.start <= REG.JAM_PROTECT_EN) {
      p.seen.protect = now;
    }
    if (a.hist) {
      p.hist = { mapId, ...a.hist };
      p.seen.hist = now;
    }
    const L = m.legacy;
    L.status = a.status;
    L.fwDate = a.fwDate ?? L.fwDate;
    L.busTargetId = a.busTargetId ?? L.busTargetId;
    m.seen.info = now;
    m.stats.rx++;
    this.changed();
  }

  changed() {
    this.emit('update', this.model);
  }

  addLog(kind, text) {
    const entry = { t: Date.now(), kind, text };
    this.log.push(entry);
    if (this.log.length > LOG_MAX) {
      this.log.shift();
    }
    this.emit('log', entry);
  }
}
