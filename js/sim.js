/**
 * Simulated datalogger (demo mode / tests): speaks the same protocol as the firmware and
 * plugs into Session like BleLink. It cuts its notifications at random sizes (BLE fragments)
 * and sends blocks larger than the negotiated payload as multi frames waiting for ACK / END,
 * so the demo exercises the whole receive path.
 */
import {
  FrameParser, OP, REPLY, buildFrame, buildMultiFrame,
} from './protocol.js';

const ID_TO_PC = 0x21;
const MULTI_INFO = 8;

export class SimLink extends EventTarget {
  constructor({ fragment = true, payloadCap = 229, pcbaCount = 1 } = {}) {
    super();
    this.fragment = fragment;
    this.payloadCap = payloadCap;
    this.pcbaCount = pcbaCount;
    this.parser = new FrameParser();
    this.connectedFlag = false;
    this.payload = 12;                         // TL default before MAX_PAYLOAD
    this.pcConnected = false;
    this.sentInfo = false;
    this.timers = [];
    this.tick = 0;
    this.multiTx = null;
    this.txQueue = [];
  }

  get name() {
    return 'Debugger-DEMO';
  }

  get connected() {
    return this.connectedFlag;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async choose() {}

  async connect() {
    this.emit('state', 'connecting');
    await sleep(300);
    this.connectedFlag = true;
    this.emit('state', 'connected');
    this.timers.push(setInterval(() => this.cycle(), 250));
  }

  disconnect() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.connectedFlag = false;
    this.pcConnected = false;
    this.sentInfo = false;
    this.multiTx = null;
    this.txQueue = [];
    this.emit('state', 'disconnected');
  }

  async write(bytes) {
    if (!this.connectedFlag) {
      throw new Error('not connected');
    }
    await sleep(5);
    for (const f of this.parser.push(bytes)) {
      this.onRequest(f);
    }
  }

  /* ------------------------------------------------------------------ device side */
  onRequest(f) {
    // multi TX flow control from the app
    if (this.multiTx && f.cmd === (this.multiTx.op & 0x0FFF)) {
      if (f.reply === REPLY.MULTI_ACK || f.reply === REPLY.MULTI_NACK) {
        if (f.reply === REPLY.MULTI_ACK) {
          this.multiTx.cur++;
        }
        this.sendMultiPiece();
        return;
      }
      if (f.reply === REPLY.MULTI_END) {
        this.multiTx = null;
        this.flushQueue();
        return;
      }
    }
    if (f.reply === REPLY.DATA) {
      return;                                  // ACK of one of our pushes
    }
    const d = f.data;
    switch (f.cmd) {
      case OP.HANDSHAKE:
        this.reply(f.cmd, [0, 1, 1]);
        break;
      case OP.MAX_PAYLOAD: {
        let n = this.payloadCap;
        n = d[0] < 9 ? 9 : Math.min(d[0], n);
        this.reply(f.cmd, [n]);
        this.payload = n;
        break;
      }
      case OP.VERIFY_TIME:
        this.reply(f.cmd, [0]);
        break;
      case OP.DATALOGGER_INFO:
        this.reply(f.cmd, [2, 5, 1, 1, 1,
          0x78, 0x56, 0x34, 0x12, 0xEF, 0xCD, 0xAB, 0x90, 0x44, 0x33, 0x22, 0x11]);
        this.pcConnected = true;
        break;
      case OP.PCBA_INFO:
        this.reply(f.cmd, regBlock(d[0], 0, this.regs(d[0]).slice(0, 22)));
        break;
      case OP.PCBA_PROTECT:
        this.reply(f.cmd, regBlock(d[0], 131, this.regs(d[0]).slice(131, 174)));
        break;
      case OP.HIST_ERROR:
        this.reply(f.cmd, [d[0], 0, 0x21, 0x05, 0x00, 0x13]);
        break;
      default:
        break;
    }
  }

  reply(cmd, data) {
    this.out(cmd | REPLY.DATA, data);
  }

  push(cmd, data) {
    this.out(cmd | REPLY.REQUIRED, data);
  }

  /** TL_Send_Data: single frame if it fits, multi frame otherwise (one at a time). */
  out(op, data) {
    if (this.multiTx) {
      this.txQueue.push([op, data]);
      return;
    }
    if (data.length <= this.payload) {
      this.notify(buildFrame(op, data, ID_TO_PC));
      return;
    }
    const per = this.payload - MULTI_INFO;
    this.multiTx = { op, data, per, total: Math.ceil(data.length / per), cur: 1 };
    this.sendMultiPiece();
  }

  sendMultiPiece() {
    const m = this.multiTx;
    if (m.cur > m.total) {
      return;                                  // waiting for END
    }
    const chunk = m.data.slice((m.cur - 1) * m.per, m.cur * m.per);
    this.notify(buildMultiFrame(m.op, m.total, m.cur, chunk, ID_TO_PC));
  }

  flushQueue() {
    while (!this.multiTx && this.txQueue.length) {
      const [op, data] = this.txQueue.shift();
      this.out(op, data);
    }
  }

  notify(frame) {
    if (!this.fragment) {
      queueMicrotask(() => this.emit('data', frame));
      return;
    }
    let o = 0;
    while (o < frame.length) {
      const n = 1 + Math.floor(Math.random() * 20);
      const part = frame.slice(o, o + n);
      o += n;
      setTimeout(() => this.emit('data', part), 0);
    }
  }

  cycle() {
    if (!this.pcConnected) {
      return;
    }
    this.tick++;
    if (!this.sentInfo) {
      this.sentInfo = true;
      for (let id = 0; id < this.pcbaCount; id++) {
        const r = this.regs(id);
        this.push(OP.PCBA_INFO, regBlock(id, 0, r.slice(0, 22)));
        this.push(OP.PCBA_PROTECT, regBlock(id, 131, r.slice(131, 174)));
        this.push(OP.HIST_ERROR, [id, 0, 0x21, 0x05, 0x00, 0x13]);
      }
      return;
    }
    for (let id = 0; id < this.pcbaCount; id++) {
      this.push(OP.PCBA_RUNNING, regBlock(id, 32, this.regs(id).slice(32, 55)));
    }
    if (this.tick % 4 === 0) {
      this.push(OP.UPLOAD_TEMP, this.tempPayload());
      this.push(OP.UPLOAD_SELF_VI, le16s([401 + (this.tick % 5), 12 + (this.tick % 3)]));
    }
    if (this.tick % 8 === 0) {
      this.push(OP.UPLOAD_BMS, this.bmsPayload());
    }
  }

  /** Plausible register set of a 40 V tool PCBA (T-Tech protocol 3.3). */
  regs(id) {
    const r = new Array(256).fill(0);
    const ph = this.tick / 8;
    r[0] = 0x4E21; r[1] = 0x10D2;              // PN 282218017
    r[2] = 0x0303;                             // protocol 3.3
    r[3] = 0x0105;                             // FW 1.5
    r[4] = 1;
    r[5] = (this.pcbaCount << 8) | 1;
    r[6] = 0x1A2B; r[10] = 0x0001; r[11] = 0x0203; r[12] = 0x0405; r[13] = 0x0607; r[14] = 0x0809;
    r[7] = 40; r[8] = 3600; r[9] = 866;
    r[15] = 0x4E22; r[16] = 0x10D2;
    r[17] = 1100; r[18] = 10; r[19] = 4317; r[20] = 1; r[21] = 10;
    const running = Math.sin(ph) > -0.3;
    r[32] = running ? 2 : 1;
    r[33] = 0;
    r[34] = running ? Math.round(18000 + 2500 * Math.sin(ph * 1.7)) : 0;
    r[35] = running ? Math.round(1300 + 250 * Math.sin(ph * 2.1)) + id * 20 : 866;
    r[36] = Math.round(1150 - 15 * Math.sin(ph));
    r[37] = Math.round(2100 + 40 * Math.sin(ph / 3));
    r[38] = running ? 3900 : 0;
    r[39] = running ? Math.round(3000 + 400 * Math.sin(ph)) : 0;
    r[40] = this.tick & 0xFFFF; r[41] = 1234; r[42] = 1;
    for (let i = 43; i <= 54; i++) {
      r[i] = (0x1000 * ((i - 43) % 16) + i) & 0xFFFF;
    }
    const prot = [[1, 60, 100], [1, 80, 5], [1, 70, 10], [0, 0, 0], [0, 0, 0], [0, 0, 0],
      [1, 440, 50], [1, 300, 50], [1, 85, 1000], [1, 0, 1000], [0, 0, 0], [0, 0, 0], [1, 160, 10], [1, 130, 10]];
    prot.forEach(([en, v, t], i) => {
      r[131 + 3 * i] = en; r[132 + 3 * i] = v; r[133 + 3 * i] = t;
    });
    r[173] = 1;
    return r;
  }

  tempPayload() {
    const out = [];
    for (let ch = 0; ch < 6; ch++) {
      const uV = ch === 0 ? 1234567 : 1000 + ch * 200 + (this.tick % 7) * 10;
      const t = ch === 5 ? -1000 : 250 + ch * 15 + (this.tick % 5);
      out.push(...le32(uV), ...le16s([t]));
    }
    return out;
  }

  bmsPayload() {
    return [
      ...le32(282230001), 1, 2, ...le32(282230101), 3, 4, 5,
      ...le16s([856, 401, 20000 - 125, 300 + 28, 0x0000]), 0x01, 0x00,
    ];
  }
}

function regBlock(mapId, start, values) {
  return [mapId, start, values.length, ...le16s(values)];
}

function le16s(values) {
  const out = [];
  for (const v of values) {
    out.push(v & 0xFF, (v >> 8) & 0xFF);
  }
  return out;
}

function le32(v) {
  return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
