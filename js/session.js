/**
 * Datalogger session over any byte transport ({ write(bytes): Promise, 'data' / 'state' events }).
 *
 * Start-up (same order the firmware expects, app_np_ble.c APP_NP_BLE_Task):
 *   HANDSHAKE -> MAX_PAYLOAD (negotiated size) -> VERIFY_TIME (phone time) -> DATALOGGER_INFO
 * DATALOGGER_INFO sets the datalogger "PC connected" flag; from then on it pushes by itself:
 *   0x005 / 0x007 / 0x00D once per PCBA, then 0x006 running registers every bus cycle,
 *   0x01A temperature, 0x01B own V/I, 0x01C / 0x01D battery.
 * Pushes carry REPLY.REQUIRED and are answered with Data[0] = 0 (Send_PCBA_Info_To_PC waits for it).
 * The datalogger drops the session after 10 s without any frame: a keep-alive HANDSHAKE goes out
 * when nothing was sent for KEEPALIVE_MS.
 *
 * Read only: no command here changes the device configuration (VERIFY_TIME only sets its RTC).
 */
import {
  FrameParser, MultiAssembler, OP, OP_NAME, REPLY, TYPE_MULTI, ackPush, request, hex,
} from './protocol.js';
import {
  MAX_PCBAS, decodeBat18, decodeBms40, decodeDataloggerInfo, decodeHandshake, decodeHistError,
  decodeRegBlock, decodeSelfVI, decodeTemp,
} from './decode.js';

const KEEPALIVE_MS = 3000;
const RESPONSE_TIMEOUT_MS = 1500;
/** Requested payload size: the datalogger answers min(this, its MTU - 8). */
const WANTED_PAYLOAD = 255;
const LOG_MAX = 300;

export function emptyModel() {
  return {
    handshake: null,
    payloadSize: null,
    info: null,
    selfVI: null,
    temp: null,
    bms40: null,
    bat18: null,
    pcba: Array.from({ length: MAX_PCBAS }, () => ({
      regs: new Array(256).fill(null),
      hist: null,
      seen: { info: 0, run: 0, protect: 0, hist: 0 },
    })),
    seen: { info: 0, selfVI: 0, temp: 0, bms: 0 },
    stats: { rx: 0, tx: 0, crc: 0, multi: 0 },
  };
}

export class Session extends EventTarget {
  constructor(transport, { handshakeTries = 3 } = {}) {
    super();
    this.t = transport;
    this.handshakeTries = handshakeTries;
    this.parser = new FrameParser();
    this.multi = new MultiAssembler();
    this.model = emptyModel();
    this.waiters = [];
    this.log = [];
    this.lastTx = 0;
    this.timer = null;
    this.running = false;
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
    this.multi.reset();
    this.running = true;

    let hs;
    try {
      hs = await this.ask(OP.HANDSHAKE, [], this.handshakeTries);
    } catch (err) {
      err.noHandshake = true;           // lets the caller fall back to the legacy protocol
      throw err;
    }
    this.model.handshake = decodeHandshake(hs.data);

    const mp = await this.ask(OP.MAX_PAYLOAD, [WANTED_PAYLOAD], 3);
    this.model.payloadSize = mp.data[0];

    // the clock is a convenience: a missing answer must not block the monitoring
    const n = new Date();
    try {
      await this.ask(OP.VERIFY_TIME, [n.getFullYear() % 100, n.getMonth() + 1, n.getDate(),
        n.getHours(), n.getMinutes(), n.getSeconds()], 2);
    } catch (err) {
      this.addLog('err', `RTC not set: ${err.message}`);
    }

    const info = await this.ask(OP.DATALOGGER_INFO, [], 3);
    this.model.info = decodeDataloggerInfo(info.data);
    this.model.seen.info = Date.now();
    this.changed();

    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.running && Date.now() - this.lastTx >= KEEPALIVE_MS) {
        this.send(request(OP.HANDSHAKE)).catch(() => {});
      }
    }, 1000);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('session stopped'));
    }
    this.waiters = [];
  }

  /** Re-reads the static blocks of one PCBA (read only requests). */
  async refreshPcba(mapId) {
    for (const op of [OP.PCBA_INFO, OP.PCBA_PROTECT, OP.HIST_ERROR]) {
      try {
        await this.ask(op, [mapId], 2);
      } catch (err) {
        this.addLog('err', `${OP_NAME[op]} map ${mapId}: ${err.message}`);
      }
    }
  }

  /* ------------------------------------------------------------------ tx */
  async send(bytes) {
    this.lastTx = Date.now();
    this.model.stats.tx++;
    this.addLog('tx', hex(bytes));
    await this.t.write(bytes);
  }

  /** Sends a request and waits for its REPLY.DATA answer (retries on timeout). */
  async ask(cmd, data = [], tries = 1) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      const wait = this.waitFor(cmd);
      try {
        await this.send(request(cmd, data));
        return await wait.promise;
      } catch (err) {
        wait.cancel();
        lastErr = err;
      }
    }
    throw lastErr;
  }

  waitFor(cmd) {
    let w;
    const promise = new Promise((resolve, reject) => {
      w = { cmd, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`no answer to ${OP_NAME[cmd] || cmd.toString(16)}`));
      }, RESPONSE_TIMEOUT_MS);
      this.waiters.push(w);
    });
    return {
      promise,
      cancel: () => {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
      },
    };
  }

  /* ------------------------------------------------------------------ rx */
  rxBytes(bytes) {
    const before = this.parser.crcErrors;
    for (const f of this.parser.push(bytes)) {
      if (f.type === TYPE_MULTI) {
        this.model.stats.multi++;
        this.addLog('rx', `${hex(f.raw)}  [multi ${f.current}/${f.total}]`);
        const { reply, frame } = this.multi.feed(f);
        if (reply) {
          this.send(reply).catch(() => {});
        }
        if (frame) {
          this.handle(frame);
        }
      } else {
        this.addLog('rx', hex(f.raw));
        this.handle(f);
      }
    }
    if (this.parser.crcErrors !== before) {
      this.model.stats.crc = this.parser.crcErrors;
      this.addLog('err', `CRC error (${this.parser.crcErrors})`);
    }
  }

  handle(f) {
    this.model.stats.rx++;
    if (f.reply === REPLY.REQUIRED) {
      this.send(ackPush(f.cmd)).catch(() => {});
    }
    if (f.reply === REPLY.DATA) {
      const w = this.waiters.find((x) => x.cmd === f.cmd);
      if (w) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(f);
      }
    }
    if (f.reply === REPLY.REQUIRED || f.reply === REPLY.DATA) {
      this.apply(f);
    }
  }

  /** Stores the decoded payload in the model. */
  apply(f) {
    const m = this.model;
    const now = Date.now();
    switch (f.cmd) {
      case OP.PCBA_INFO:
      case OP.PCBA_RUNNING:
      case OP.PCBA_PROTECT: {
        const blk = decodeRegBlock(f.data);
        if (!blk || blk.mapId >= MAX_PCBAS) {
          return;
        }
        const p = m.pcba[blk.mapId];
        blk.values.forEach((v, i) => {
          if (blk.start + i < 256) {
            p.regs[blk.start + i] = v;
          }
        });
        const key = f.cmd === OP.PCBA_INFO ? 'info' : (f.cmd === OP.PCBA_RUNNING ? 'run' : 'protect');
        p.seen[key] = now;
        break;
      }
      case OP.HIST_ERROR: {
        const h = decodeHistError(f.data);
        if (h && h.mapId < MAX_PCBAS) {
          m.pcba[h.mapId].hist = h;
          m.pcba[h.mapId].seen.hist = now;
        }
        break;
      }
      case OP.UPLOAD_TEMP:
        m.temp = decodeTemp(f.data);
        m.seen.temp = now;
        break;
      case OP.UPLOAD_SELF_VI:
        m.selfVI = decodeSelfVI(f.data);
        m.seen.selfVI = now;
        break;
      case OP.UPLOAD_BMS:
        m.bms40 = decodeBms40(f.data);
        m.seen.bms = now;
        break;
      case OP.UPLOAD_18V_BAT:
        m.bat18 = decodeBat18(f.data);
        m.seen.bms = now;
        break;
      case OP.DATALOGGER_INFO:
        m.info = decodeDataloggerInfo(f.data);
        m.seen.info = now;
        break;
      default:
        return;
    }
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
