/**
 * Chart page: records the values the session receives and draws them on one shared time axis.
 *
 * Machine model
 *   input : sample(model) on every session 'update'; a source (running registers, temperature,
 *           datalogger V/I, battery) is recorded each time its frame arrives, stamped with the
 *           receive time, so every value keeps its real rate. start() / stop() / clear(),
 *           signal choice, time window, zoom.
 *   output: one chart per unit, stacked, all with the same x range and a synced cursor; each chart
 *           header names its series with their values at the cursor (or the latest ones), under
 *           a sticky time row; PNG export.
 *   timing: recording runs whatever page is shown; drawing runs at most REDRAW_HZ times a second
 *           and only while the chart page is visible.
 * One unit per chart, so no chart ever has two y scales. Only the PCBA selected at start is
 * recorded (the caller locks the PCBA tabs while recording). The last MAX_RECORD_S are kept.
 */
import { pcbaView } from './decode.js';

/* global uPlot */

const REDRAW_HZ = 10;
const SLOW_REDRAW_POINTS = 20000;      // above this many visible points redraw once a second
const MAX_RECORD_S = 3600;
const TRIM_EVERY_S = 60;
const CHART_HEIGHT = 150;
const GAP_MIN_S = 1.5;                 // a pause longer than max(this, 3 x usual period) is a gap
const WINDOWS = [[30, '30 s'], [60, '1 min'], [300, '5 min'], [900, '15 min'], [0, 'All']];
const STORE_KEY = 'dl-chart-signals';

/* Categorical palette (dataviz reference palette), validated on the card surfaces of app.css:
 * light #ffffff and dark #131c25, adjacent pairs, CVD and normal vision. The light run needs the
 * value row (visible labels) because three slots are under 3:1 on white. */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

const signed16 = (x) => (x == null ? null : (x & 0x8000 ? x - 0x10000 : x));
const tc = (i) => (m) => {
  const c = m.temp?.[i];
  return c && !c.burnout ? c.tempX10 / 10 : null;
};

/** Every value that can be recorded. `slot` is the fixed colour slot inside its unit's chart. */
const SIGNALS = [
  { id: 'cur', label: 'Current', unit: 'A', src: 'run', get: (v) => v.run.currentA, slot: 0, on: true },
  { id: 'vol', label: 'Voltage', unit: 'V', src: 'run', get: (v) => v.run.voltageV, slot: 0, on: true },
  { id: 'pow', label: 'Power', unit: 'W', src: 'run', get: (v) => v.run.powerW, slot: 0 },
  { id: 'pcbaT', label: 'PCBA temp', unit: '°C', src: 'run', get: (v) => v.run.tempC, slot: 0, on: true },
  { id: 'rpm', label: 'Speed', unit: 'RPM', src: 'run', get: (v) => v.run.rpm, slot: 0, on: true },
  { id: 'duty', label: 'Duty', unit: '%', src: 'run', get: (v) => v.run.dutyPct, slot: 0 },
  { id: 'pot', label: 'ADC Pot', unit: '%', src: 'run', get: (v) => v.run.potPct, slot: 1 },
  { id: 'dbg1', label: 'Debug Data1', unit: 'raw', src: 'run', get: (v) => signed16(v.run.debug1), slot: 0 },
  { id: 'dbg2', label: 'Debug Data2', unit: 'raw', src: 'run', get: (v) => signed16(v.run.debug2), slot: 1 },
  { id: 'tc0', label: 'TC CH0', unit: 'mV', src: 'temp', get: (m) => (m.temp?.[0] ? m.temp[0].uV / 1000 : null), slot: 0 },
  ...[1, 2, 3, 4, 5].map((i) => ({ id: `tc${i}`, label: `TC CH${i}`, unit: '°C', src: 'temp', get: tc(i), slot: i })),
  { id: 'busV', label: 'Bus voltage', unit: 'V', src: 'selfVI', get: (m) => (m.selfVI ? m.selfVI.vX10 / 10 : null), slot: 1 },
  { id: 'busI', label: 'Bus current', unit: 'A', src: 'selfVI', get: (m) => (m.selfVI ? m.selfVI.iX10 / 10 : null), slot: 1 },
  { id: 'soc', label: 'Battery SOC', unit: '%', src: 'bms', get: (m) => m.bms40?.socPct ?? null, slot: 2 },
  { id: 'batV', label: 'Battery voltage', unit: 'V', src: 'bms', get: (m) => m.bms40?.voltageV ?? null, slot: 2 },
  { id: 'batI', label: 'Battery current', unit: 'A', src: 'bms', get: (m) => m.bms40?.currentA ?? null, slot: 2 },
];
const UNITS = ['A', 'V', 'W', '°C', 'RPM', '%', 'mV', 'raw'];
const GROUPS = [['run', 'Tool (selected PCBA)'], ['temp', 'Thermocouple'], ['selfVI', 'Datalogger'], ['bms', 'Battery (40 V)']];
const SIG = Object.fromEntries(SIGNALS.map((s) => [s.id, s]));
const DIGITS = { A: 1, V: 1, W: 0, '°C': 1, RPM: 0, '%': 0, mV: 3, raw: 0 };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Seconds -> "m:ss" / "h:mm:ss", with tenths when `fine`. */
function fmtTime(s, fine = false) {
  if (s == null || Number.isNaN(s)) {
    return '–';
  }
  const neg = s < 0;
  let a = Math.abs(s);
  const h = Math.floor(a / 3600);
  a -= h * 3600;
  const m = Math.floor(a / 60);
  const sec = a - m * 60;
  const ss = fine ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return `${neg ? '-' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${ss}`;
}

/** Index of the last element <= x (-1 when none). */
function lastAtOrBefore(arr, x) {
  let lo = 0;
  let hi = arr.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/** Colours of the PNG export: always the light theme (white paper for reports and print). */
const EXPORT_COLORS = {
  series: SERIES_LIGHT, surface: '#ffffff', text: '#0f1720', muted: '#5b6875', line: '#dde3e9', bad: '#b91c1c',
};

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    series: dark ? SERIES_DARK : SERIES_LIGHT,
    surface: v('--card'), text: v('--text'), muted: v('--muted'), line: v('--line'), bad: v('--bad'),
  };
}

/* ------------------------------------------------------------------ recorder */
class Recorder {
  constructor() {
    this.clear();
  }

  clear() {
    this.running = false;
    this.t0 = null;                    // epoch ms of the first start: x = 0
    this.mapId = 0;
    this.lastSeen = {};
    this.src = {};                     // source -> { t: [], cols: { id: [] }, period }
    for (const [g] of GROUPS) {
      this.src[g] = { t: [], cols: {}, period: 0 };
      for (const s of SIGNALS.filter((x) => x.src === g)) {
        this.src[g].cols[s.id] = [];
      }
    }
    this.events = [];                  // { t, text, fault }
    this.lastSm = null;
    this.lastErr = null;
    this.lastTrim = 0;
  }

  start(mapId) {
    if (this.t0 == null) {
      this.t0 = Date.now();
    }
    this.mapId = mapId;
    this.running = true;
    this.lastSeen = {};
  }

  stop() {
    this.running = false;
  }

  /** Seconds since the first start. */
  now() {
    return this.t0 == null ? 0 : (Date.now() - this.t0) / 1000;
  }

  get hasData() {
    return Object.values(this.src).some((s) => s.t.length);
  }

  /** Records every source whose frame is newer than the last one recorded. */
  sample(m) {
    if (!this.running) {
      return false;
    }
    const seen = {
      run: m.pcba[this.mapId]?.seen.run || 0,
      temp: m.seen.temp || 0,
      selfVI: m.seen.selfVI || 0,
      bms: m.seen.bms || 0,
    };
    let added = false;
    let view = null;
    for (const [g] of GROUPS) {
      const ts = seen[g];
      if (!ts || ts <= (this.lastSeen[g] || 0) || ts < this.t0) {
        continue;
      }
      // a frame received before this start (e.g. while stopped) is not part of the recording
      const first = this.lastSeen[g] == null;
      this.lastSeen[g] = ts;
      if (first && Date.now() - ts > 1000) {
        continue;
      }
      const ctx = g === 'run' ? (view ??= pcbaView(m.pcba[this.mapId].regs)) : m;
      const t = (ts - this.t0) / 1000;
      const S = this.src[g];
      const prev = S.t.length ? S.t[S.t.length - 1] : null;
      if (prev != null && t - prev < 30) {
        S.period = S.period ? S.period * 0.9 + (t - prev) * 0.1 : t - prev;
      }
      S.t.push(t);
      for (const s of SIGNALS) {
        if (s.src === g) {
          const v = s.get(ctx);
          S.cols[s.id].push(v == null || Number.isNaN(v) ? null : v);
        }
      }
      if (g === 'run') {
        this.trackEvents(t, ctx.run);
      }
      added = true;
    }
    if (added) {
      this.trim();
    }
    return added;
  }

  /** Motor_SM changes and new fault codes become markers on every chart. */
  trackEvents(t, run) {
    if (run.sm != null && run.sm !== this.lastSm) {
      if (this.lastSm != null) {
        this.events.push({ t, text: run.sm, fault: run.sm === 'FAULT' });
      }
      this.lastSm = run.sm;
    }
    if (run.errorCode != null && run.errorCode !== this.lastErr) {
      if (run.errorCode) {
        this.events.push({ t, text: `Fault 0x${run.errorCode.toString(16).toUpperCase().padStart(2, '0')}`, fault: true });
      }
      this.lastErr = run.errorCode;
    }
  }

  /** Keeps the last MAX_RECORD_S seconds (checked once a minute). */
  trim() {
    const now = this.now();
    if (now - this.lastTrim < TRIM_EVERY_S) {
      return;
    }
    this.lastTrim = now;
    const from = now - MAX_RECORD_S;
    if (from <= 0) {
      return;
    }
    for (const S of Object.values(this.src)) {
      const n = lastAtOrBefore(S.t, from) + 1;
      if (n > 0) {
        S.t.splice(0, n);
        for (const k of Object.keys(S.cols)) {
          S.cols[k].splice(0, n);
        }
      }
    }
    this.events = this.events.filter((e) => e.t >= from);
  }

  gapOf(g) {
    return Math.max(GAP_MIN_S, 3 * (this.src[g].period || 0));
  }

  /** Rows of one source inside [min, max] (one more each side), with a null row in each gap. */
  slice(g, ids, min, max) {
    const S = this.src[g];
    const i0 = Math.max(0, lastAtOrBefore(S.t, min));
    const i1 = Math.min(S.t.length - 1, lastAtOrBefore(S.t, max) + 1);
    const gap = this.gapOf(g);
    const x = [];
    const ys = ids.map(() => []);
    for (let i = i0; i <= i1; i++) {
      if (i > i0 && S.t[i] - S.t[i - 1] > gap) {
        x.push((S.t[i] + S.t[i - 1]) / 2);
        ys.forEach((y) => y.push(null));
      }
      x.push(S.t[i]);
      ids.forEach((id, k) => ys[k].push(S.cols[id][i]));
    }
    return [x, ...ys];
  }

  /** Value of a signal at time t: the last sample at or before t, unless it is older than a gap. */
  valueAt(id, t) {
    const s = SIG[id];
    const S = this.src[s.src];
    const i = lastAtOrBefore(S.t, t);
    if (i < 0 || t - S.t[i] > this.gapOf(s.src)) {
      return null;
    }
    return S.cols[id][i];
  }

  lastTime() {
    let t = 0;
    for (const S of Object.values(this.src)) {
      if (S.t.length) {
        t = Math.max(t, S.t[S.t.length - 1]);
      }
    }
    return t;
  }
}

/* ------------------------------------------------------------------ page */
export class ChartPage {
  /**
   * @param {object} host  getSession(), getPcba(), deviceName(), pcbaLabel(mapId), onRecording(bool)
   */
  constructor(host) {
    this.host = host;
    this.rec = new Recorder();
    this.charts = [];                  // { unit, ids, u }
    this.windowS = 60;
    this.live = true;
    this.view = null;                  // { min, max } while zoomed
    this.cursorT = null;
    this.visible = false;
    this.dirty = true;
    this.lastDraw = 0;
    this.syncing = false;
    this.wakeLock = null;
    this.selected = this.loadSelection();
    this.buildControls();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe($('chCharts'));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.rebuild());
    setInterval(() => this.tick(), 1000 / REDRAW_HZ);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.rec.running) {
        this.requestWakeLock();
      }
    });
  }

  get recording() {
    return this.rec.running;
  }

  /* ---------------- controls */
  buildControls() {
    $('chWindow').innerHTML = WINDOWS.map(([s, label]) => `<button type="button" class="btn btn-small" data-win="${s}">${label}</button>`).join('')
      + '<button type="button" class="btn btn-small" id="chLive">Live</button>'
      + '<button type="button" class="btn btn-small btn-primary" id="chReset" hidden>⤢ Reset zoom</button>';
    $('chWindow').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) {
        return;
      }
      if (b.dataset.win != null) {
        this.windowS = Number(b.dataset.win);
      }
      this.goLive();
    });
    $('chStart').addEventListener('click', () => this.start());
    $('chStop').addEventListener('click', () => this.stop());
    $('chClear').addEventListener('click', () => this.clear());
    $('chPng').addEventListener('click', () => this.exportPng());
    $('chSigList').addEventListener('change', (e) => {
      const id = e.target.dataset.sig;
      if (!id) {
        return;
      }
      if (e.target.checked) {
        this.selected.add(id);
      } else {
        this.selected.delete(id);
      }
      this.saveSelection();
      this.rebuild();
    });
    this.renderSignalList();
    this.renderControls();
  }

  renderSignalList() {
    const legacy = !!this.host.getSession()?.legacy;
    const html = GROUPS.filter(([g]) => !legacy || g === 'run').map(([g, title]) => {
      const items = SIGNALS.filter((s) => s.src === g).map((s) => `<label><input type="checkbox" data-sig="${s.id}"`
        + `${this.selected.has(s.id) ? ' checked' : ''}> ${esc(s.label)} <span class="muted">(${esc(s.unit)})</span></label>`).join('');
      return `<fieldset><legend>${esc(title)}</legend>${items}</fieldset>`;
    }).join('');
    if ($('chSigList').innerHTML !== html) {
      $('chSigList').innerHTML = html;
    }
    $('chSigCount').textContent = `(${this.shownIds().length} selected)`;
  }

  renderControls() {
    const r = this.rec;
    $('chStart').disabled = r.running;
    $('chStop').disabled = !r.running;
    $('chClear').disabled = r.running || !r.hasData;
    $('chPng').disabled = !r.hasData;
    document.querySelectorAll('#chWindow [data-win]').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.win) === this.windowS && this.live);
    });
    $('chLive').classList.toggle('on', this.live);
    $('chReset').hidden = this.live;     // only while zoomed
    const status = $('chRec');
    if (r.running) {
      status.innerHTML = `<span class="rec-dot" aria-hidden="true"></span> REC ${fmtTime(r.now())} · ${esc(this.host.pcbaLabel(r.mapId))}`;
    } else {
      status.textContent = r.hasData ? `Stopped at ${fmtTime(r.lastTime())} · ${this.host.pcbaLabel(r.mapId)}` : 'Not recording';
    }
  }

  loadSelection() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY));
      if (Array.isArray(v)) {
        return new Set(v.filter((id) => SIG[id]));
      }
    } catch {
      /* storage blocked: defaults */
    }
    return new Set(SIGNALS.filter((s) => s.on).map((s) => s.id));
  }

  saveSelection() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...this.selected]));
    } catch {
      /* not kept */
    }
  }

  /** Selected signals the current session can deliver. */
  shownIds() {
    const legacy = !!this.host.getSession()?.legacy;
    return SIGNALS.filter((s) => this.selected.has(s.id) && (!legacy || s.src === 'run')).map((s) => s.id);
  }

  /* ---------------- recording */
  sample(model) {
    if (this.rec.sample(model)) {
      this.dirty = true;
    }
  }

  start() {
    this.rec.start(this.host.getPcba());
    this.host.onRecording(true);
    this.requestWakeLock();
    this.goLive();
  }

  stop() {
    this.rec.stop();
    this.host.onRecording(false);
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.dirty = true;
    this.renderControls();
  }

  clear() {
    if (this.rec.running) {
      return;
    }
    this.rec.clear();
    this.view = null;
    this.live = true;
    this.cursorT = null;
    this.dirty = true;
    this.renderControls();
  }

  /** Keeps the phone screen on while recording (BLE stops when the phone sleeps). */
  async requestWakeLock() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* not supported or refused */
    }
  }

  /* ---------------- page visibility */
  show(on) {
    this.visible = on;
    if (on) {
      this.renderSignalList();
      if (!this.charts.length || this.stale) {
        this.rebuild();
      } else {
        this.resize();
      }
    }
  }

  /** A new session can offer other signals (the legacy protocol carries tool registers only). */
  onSession() {
    this.renderSignalList();
    this.stale = true;
    if (this.visible) {
      this.rebuild();
    }
  }

  goLive() {
    this.live = true;
    this.view = null;
    this.dirty = true;
    this.renderControls();
  }

  /** x range shown on every chart. */
  range() {
    if (!this.live && this.view) {
      return this.view;
    }
    const max = Math.max(this.rec.running ? this.rec.now() : this.rec.lastTime(), 1);
    const min = this.windowS ? Math.max(0, max - this.windowS) : 0;
    // while recording the first minutes fill the window from the left; once stopped, the data only
    return { min, max: this.rec.running && this.windowS && max < this.windowS ? this.windowS : max };
  }

  /* ---------------- charts */
  groups() {
    const ids = this.shownIds();
    return UNITS.map((unit) => ({ unit, ids: ids.filter((id) => SIG[id].unit === unit) })).filter((g) => g.ids.length);
  }

  rebuild() {
    for (const c of this.charts) {
      c.u.destroy();
    }
    this.charts = [];
    this.stale = false;
    const host = $('chCharts');
    host.innerHTML = '';
    this.renderSignalList();
    const groups = this.groups();
    $('chEmpty').hidden = groups.length > 0;
    const width = Math.max(240, host.clientWidth);
    for (const g of groups) {
      const box = document.createElement('div');
      box.className = 'chart-box';
      const head = document.createElement('div');
      head.className = 'chart-h';
      const plot = document.createElement('div');
      box.append(head, plot);
      host.appendChild(box);
      const u = new uPlot(this.options(g, width, CHART_HEIGHT, 1, true), [[], ...g.ids.map(() => [])], plot);
      this.charts.push({ ...g, u, head });
    }
    this.dirty = true;
    this.draw(true);
  }

  resize() {
    const w = Math.max(240, $('chCharts').clientWidth);
    for (const c of this.charts) {
      if (c.u.width !== w) {
        c.u.setSize({ width: w, height: CHART_HEIGHT });
      }
    }
  }

  /**
   * uPlot options of one chart. `k` scales fonts, lines and paddings (PNG export renders at a
   * larger size); `interactive` adds the synced cursor and the drag-to-zoom; `c` = colours.
   */
  options(g, width, height, k, interactive, c = themeColors()) {
    const font = `${11 * k}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const axis = {
      stroke: c.muted, font, labelFont: font,
      grid: { stroke: c.line, width: 1 * k },
      ticks: { stroke: c.line, width: 1 * k, size: 4 * k },
    };
    const self = this;
    return {
      width,
      height,
      padding: [8 * k, 22 * k, 0, 0],     // room for the last time label
      legend: { show: false },
      scales: { x: { time: false, range: () => { const r = self.range(); return [r.min, r.max]; } } },
      series: [
        {},
        ...g.ids.map((id) => ({
          label: SIG[id].label,
          stroke: c.series[SIG[id].slot % c.series.length],
          width: 2 * k,
          points: { show: false },
        })),
      ],
      axes: [
        { ...axis, size: 26 * k, values: (u, vals) => vals.map((v) => fmtTime(v, (u.scales.x.max - u.scales.x.min) < 20)) },
        { ...axis, size: 52 * k, label: g.unit, labelSize: 16 * k, values: (u, vals) => vals.map((v) => +v.toFixed(6)) },
      ],
      cursor: interactive
        ? {
          sync: { key: 'dl-chart', setSeries: false },
          y: false,                          // time crosshair only
          drag: { x: true, y: false, setScale: false },
          points: { size: 8, width: 2, fill: c.surface },
        }
        : { show: false },
      select: { show: interactive },
      hooks: {
        draw: [(u) => this.drawEvents(u, k, c)],
        ...(interactive ? {
          setSelect: [(u) => this.onSelect(u)],
          setCursor: [(u) => this.onCursor(u)],
          ready: [(u) => u.over.addEventListener('dblclick', () => this.goLive())],
        } : {}),
      },
    };
  }

  /** Vertical markers for Motor_SM changes (muted) and faults (critical, with label). */
  drawEvents(u, k, c) {
    const { min, max } = u.scales.x;
    const evs = this.rec.events.filter((e) => e.t >= min && e.t <= max);
    if (!evs.length) {
      return;
    }
    const ctx = u.ctx;
    const r = devicePixelRatio || 1;
    const top = u.bbox.top;
    const bottom = u.bbox.top + u.bbox.height;
    ctx.save();
    ctx.font = `${10 * k * r}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (const e of evs) {
      const x = Math.round(u.valToPos(e.t, 'x', true));
      ctx.strokeStyle = e.fault ? c.bad : c.muted;
      ctx.globalAlpha = e.fault ? 0.9 : 0.6;
      ctx.lineWidth = 1 * k * r;
      ctx.setLineDash(e.fault ? [] : [3 * k * r, 3 * k * r]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, top);
      ctx.lineTo(x + 0.5, bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = e.fault ? c.bad : c.muted;
      ctx.fillText(e.fault ? `⚠ ${e.text}` : e.text, x + 3 * k * r, top + 2 * k * r);
    }
    ctx.restore();
  }

  onSelect(u) {
    const { left, width } = u.select;
    if (width > 4) {
      this.live = false;
      this.view = { min: u.posToVal(left, 'x'), max: u.posToVal(left + width, 'x') };
      this.dirty = true;
      this.renderControls();
    }
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
  }

  onCursor(u) {
    if (this.syncing) {
      return;
    }
    const left = u.cursor.left;
    this.cursorT = left == null || left < 0 ? null : u.posToVal(left, 'x');
    this.renderValues();
  }

  /** Chart headers: every series named, with its value at the cursor, else at the right edge. */
  renderValues() {
    const zoomed = !this.live && this.view;
    const latest = this.rec.running ? this.rec.now() : this.rec.lastTime();
    const t = this.cursorT ?? (zoomed ? Math.min(this.view.max, latest) : latest);
    const c = themeColors();
    for (const ch of this.charts) {
      ch.head.innerHTML = ch.ids.map((id) => {
        const s = SIG[id];
        const v = this.rec.hasData ? this.rec.valueAt(id, t) : null;
        const color = c.series[s.slot % c.series.length];
        return `<span class="cv"><i style="background:${color}"></i>${esc(s.label)} `
          + `<b>${v == null ? '–' : v.toFixed(DIGITS[s.unit])}</b> ${esc(s.unit)}</span>`;
      }).join('');
    }
    const zoom = zoomed ? ` · zoomed ${fmtTime(this.view.min, true)} – ${fmtTime(this.view.max, true)}` : '';
    const what = this.cursorT != null ? 'Cursor at' : (zoomed ? 'End of zoom' : 'Latest');
    $('chValues').textContent = this.rec.hasData
      ? `${what} ${fmtTime(t, true)}${zoom}`
      : 'No data recorded yet: press Start.';
  }

  tick() {
    if (this.rec.running) {
      this.renderControls();
    }
    if (this.visible) {
      this.draw(false);
    }
  }

  /** Pushes the visible window to every chart (same x range, same moment). */
  draw(force) {
    if (!this.charts.length || (!force && !this.dirty && !(this.live && this.rec.running))) {
      return;
    }
    const { min, max } = this.range();
    let points = 0;
    const data = this.charts.map((c) => {
      const bySrc = {};
      for (const id of c.ids) {
        (bySrc[SIG[id].src] ??= []).push(id);
      }
      const srcs = Object.keys(bySrc);
      const tables = srcs.map((g) => this.rec.slice(g, bySrc[g], min, max));
      let d;
      if (tables.length === 1) {
        d = tables[0];
      } else {
        d = uPlot.join(tables);           // holes from the other source are undefined: spanned
      }
      // uPlot wants the series in the chart's order
      const order = srcs.flatMap((g) => bySrc[g]);
      const out = [d[0], ...c.ids.map((id) => d[1 + order.indexOf(id)])];
      points += out[0].length * c.ids.length;
      return out;
    });
    const now = performance.now();
    if (!force && points > SLOW_REDRAW_POINTS && now - this.lastDraw < 1000) {
      return;
    }
    this.lastDraw = now;
    this.dirty = false;
    this.syncing = true;
    this.charts.forEach((c, i) => {
      c.u.setData(data[i], false);
      c.u.setScale('x', { min, max });
    });
    this.syncing = false;
    this.renderValues();
  }

  /* ---------------- PNG export */
  /** Renders every chart again at a fixed 2400 px width (any device) and saves one PNG. */
  async exportPng() {
    const OUT_W = 2400;
    const r = devicePixelRatio || 1;
    const k = OUT_W / 1200;            // layout designed at 1200 px, drawn twice as large
    const cssW = OUT_W / r;
    const chartH = 260 * k / r;
    const c = EXPORT_COLORS;
    const groups = this.groups();
    if (!groups.length) {
      return;
    }
    const tmp = document.createElement('div');
    tmp.style.cssText = `position:fixed;left:-100000px;top:0;width:${cssW}px`;
    document.body.appendChild(tmp);
    const canvases = [];
    const { min, max } = this.range();
    try {
      for (const g of groups) {
        const box = document.createElement('div');
        tmp.appendChild(box);
        const bySrc = {};
        for (const id of g.ids) {
          (bySrc[SIG[id].src] ??= []).push(id);
        }
        const srcs = Object.keys(bySrc);
        const tables = srcs.map((s) => this.rec.slice(s, bySrc[s], min, max));
        const d = tables.length === 1 ? tables[0] : uPlot.join(tables);
        const order = srcs.flatMap((s) => bySrc[s]);
        const data = [d[0], ...g.ids.map((id) => d[1 + order.indexOf(id)])];
        const opts = this.options(g, cssW, chartH, k / r, false, EXPORT_COLORS);
        // uPlot sizes and draws after construction: wait for its draw before copying the canvas
        const drawn = new Promise((res) => opts.hooks.draw.push(() => res()));
        const u = new uPlot(opts, data, box);
        u.setScale('x', { min, max });
        await drawn;
        canvases.push({ g, canvas: u.ctx.canvas, u });
      }

      const pad = 24 * k;
      const headH = 64 * k;
      const legendH = 30 * k;
      const H = headH + canvases.reduce((n, x) => n + legendH + x.canvas.height, 0) + pad;
      const out = document.createElement('canvas');
      out.width = OUT_W;
      out.height = Math.round(H);
      const ctx = out.getContext('2d');
      ctx.fillStyle = c.surface;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = c.text;
      ctx.font = `600 ${18 * k}px system-ui, sans-serif`;
      const started = new Date(this.rec.t0);
      ctx.fillText(`${this.host.deviceName() || 'Datalogger'} · ${this.host.pcbaLabel(this.rec.mapId)}`, pad, 22 * k);
      ctx.fillStyle = c.muted;
      ctx.font = `${12 * k}px system-ui, sans-serif`;
      ctx.fillText(`Recording started ${started.toLocaleString()} · shown ${fmtTime(min)} – ${fmtTime(max)} · `
        + `exported ${new Date().toLocaleString()} · Datalogger BLE Monitor v${self.APP_VERSION}`, pad, 46 * k);
      let y = headH;
      for (const { g, canvas } of canvases) {
        let x = pad;
        ctx.font = `${12 * k}px system-ui, sans-serif`;
        for (const id of g.ids) {
          const s = SIG[id];
          ctx.fillStyle = c.series[s.slot % c.series.length];
          ctx.fillRect(x, y + legendH / 2 - 5 * k, 10 * k, 10 * k);
          x += 16 * k;
          ctx.fillStyle = c.text;
          const label = `${s.label} (${s.unit})`;
          ctx.fillText(label, x, y + legendH / 2);
          x += ctx.measureText(label).width + 20 * k;
        }
        y += legendH;
        ctx.drawImage(canvas, 0, y);
        y += canvas.height;
      }
      const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
      await this.savePng(blob);
    } finally {
      canvases.forEach((x) => x.u.destroy());
      tmp.remove();
    }
  }

  async savePng(blob) {
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const name = `dl-chart-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    // iOS browsers ignore <a download>: the share sheet offers "Save Image"
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') {
          return;
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
