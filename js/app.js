/**
 * UI of the Datalogger BLE Monitor (display only).
 */
import { BleLink, bluetoothAvailable, describeError } from './ble.js';
import { Session } from './session.js';
import { LegacySession } from './legacy.js';
import { ChartPage } from './chart.js';
import { MAX_PCBAS, REG, mapIdToTargetId, pcbaView } from './decode.js';

const $ = (id) => document.getElementById(id);

const RECONNECT_TRIES = 5;
const RECONNECT_DELAY_MS = 1500;
const STALE_MS = 5000;
const LOG_LINES = 300;
const OLD_CACHE_PREFIX = 'dl-ble-monitor-';    // offline cache of versions <= 0.3.0

const ui = {
  link: null,
  session: null,
  wanted: false,           // the user wants to stay connected (auto reconnect)
  reconnecting: false,
  pcba: 0,
  renderQueued: false,
  logPaused: false,
  page: 'Monitor',
};

/* ------------------------------------------------------------------ helpers */
const DASH = '–';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const val = (v, digits) => (v == null || Number.isNaN(v) ? DASH : (digits == null ? String(v) : Number(v).toFixed(digits)));
const hexv = (v, w = 4) => (v == null ? DASH : `0x${v.toString(16).toUpperCase().padStart(w, '0')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kv(rows) {
  return rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls || ''}">${esc(v)}</dd>`).join('');
}

function tile(label, value, unit, raw, cls = '') {
  return `<div class="tile ${cls}"><div class="k">${esc(label)}</div>`
    + `<div class="v">${esc(value)}${unit && value !== DASH ? `<small>${esc(unit)}</small>` : ''}</div>`
    + `${raw != null ? `<div class="r">${esc(raw)}</div>` : ''}</div>`;
}

function setStatus(text, kind) {
  const s = $('status');
  s.textContent = text;
  s.className = `pill pill-${kind}`;
}

function showBanner(html) {
  const b = $('banner');
  b.innerHTML = html;
  b.hidden = !html;
}

/* ------------------------------------------------------------------ connection */
async function onConnectClick() {
  if (ui.link?.connected || ui.wanted) {
    ui.wanted = false;
    ui.link?.disconnect();
    return;
  }
  if (!bluetoothAvailable()) {
    showBanner(noBluetoothText());
    return;
  }
  try {
    const link = ui.link instanceof BleLink ? ui.link : new BleLink();
    await link.choose({ showAll: $('optAll').checked });     // must stay first: user gesture
    useLink(link);
    await startLink();
  } catch (err) {
    if (err?.name !== 'NotFoundError') {                    // NotFoundError = chooser cancelled
      const retrying = ui.wanted && ui.reconnecting;        // the link dropped: reconnect() is already on it
      showBanner(`Connection failed: <code>${esc(describeError(err))}</code><br>`
        + (retrying ? 'Retrying automatically… If it keeps failing: ' : 'Try: ')
        + 'turn Bluetooth off and on, make sure the datalogger is not connected to another device '
        + '(APK, PC tool), or enable <b>Show all BLE devices</b> and connect again.');
      console.error(err);
    }
  }
}

function useLink(link) {
  if (ui.link && ui.link !== link) {
    ui.link.removeEventListener('state', onLinkState);
    ui.session?.dispose();
    ui.session = null;
  }
  if (ui.link !== link) {
    link.addEventListener('state', onLinkState);
  }
  ui.link = link;
}

async function startLink() {
  ui.wanted = true;
  showBanner('');
  await ui.link.connect();
  await startSession();
}

const PROTO_LABEL = { new: 'new protocol (FW V5.x)', legacy: 'legacy 20-byte protocol (FW V4.x)' };

/**
 * Protocols to try, in order. The firmware names its BLE module from the MCU UID:
 * FW V4.x "Debugger-%03u" (Debugger_FW app_ble.c), FW V5.x "Debugger-%04u" (Datalogger_FW).
 * 'auto' starts with the protocol the name points to and falls back to the other one.
 */
function protocolOrder(choice, name) {
  if (choice !== 'auto') {
    return [choice];
  }
  return /^Debugger-\d{3}$/.test(name || '') ? ['legacy', 'new'] : ['new', 'legacy'];
}

async function startSession() {
  const choice = $('optProto').value;
  const order = protocolOrder(choice, ui.link.name);
  const tries = order.length > 1 ? 2 : 3;          // fail over sooner in auto mode
  const make = {
    new: () => new Session(ui.link, { handshakeTries: tries }),
    legacy: () => new LegacySession(ui.link, { startTries: tries }),
  };
  setStatus('Handshaking…', 'busy');
  try {
    let note = order.length > 1 ? `name ${ui.link.name || '?'}: trying the ${PROTO_LABEL[order[0]]} first` : null;
    for (let i = 0; i < order.length; i++) {
      try {
        await attach(make[order[i]](), note);
        break;
      } catch (err) {
        // the new protocol falls back only when the HANDSHAKE itself gets no answer
        const noAnswer = order[i] === 'legacy' || err.noHandshake;
        if (i === order.length - 1 || !noAnswer || !ui.link.connected) {
          throw err;
        }
        setStatus(`Trying ${order[i + 1]} protocol…`, 'busy');
        note = `${PROTO_LABEL[order[i]]}: ${err.message}. Trying the ${PROTO_LABEL[order[i + 1]]}`;
      }
    }
    const tag = ui.session.legacy ? ' (legacy)' : '';
    setStatus(`${ui.link.name || 'Connected'}${tag}`, 'on');
    // a failed first attempt leaves its error up while the automatic reconnect succeeds
    showBanner('');
    $('empty').hidden = true;
    $('view').hidden = false;
    queueRender();
  } catch (err) {
    setStatus('No response', 'busy');
    showBanner(`The device does not answer: <code>${esc(describeError(err))}</code>. `
      + 'Check that the datalogger is powered and connect again, or choose the protocol in <b>Options</b>.');
  }
}

/** Replaces the current session with `s` and starts it (throws when the device does not answer). */
async function attach(s, note) {
  ui.session?.dispose();
  ui.session = s;
  // a reconnect during a chart recording stays on the recorded PCBA
  ui.pcba = chart.recording ? chart.rec.mapId : 0;
  s.addEventListener('update', () => {
    chart.sample(s.model);
    queueRender();
  });
  s.addEventListener('log', onLog);
  if (note) {
    s.addLog('err', note);
  }
  chart.onSession();
  await s.start();
  if (ui.pcba) {
    s.select?.(ui.pcba);
  }
}

function onLinkState(e) {
  const st = e.detail;
  $('btnConnect').textContent = st === 'disconnected' ? 'Connect' : 'Disconnect';
  if (st === 'connecting') {
    setStatus('Connecting…', 'busy');
  } else if (st === 'disconnected') {
    ui.session?.stop();
    setStatus('Not connected', 'off');
    if (ui.wanted && !ui.reconnecting) {
      reconnect().finally(() => { ui.reconnecting = false; });
    }
  }
}

async function reconnect() {
  ui.reconnecting = true;
  for (let i = 1; i <= RECONNECT_TRIES && ui.wanted; i++) {
    setStatus(`Reconnecting ${i}/${RECONNECT_TRIES}…`, 'busy');
    await sleep(RECONNECT_DELAY_MS);
    if (!ui.wanted) {
      return;
    }
    try {
      await ui.link.connect();
      await startSession();
      return;
    } catch {
      /* next try */
    }
  }
  if (ui.wanted) {
    ui.wanted = false;
    setStatus('Connection lost', 'off');
    showBanner('Connection to the device lost. Press <b>Connect</b> to choose it again.');
  }
}

function noBluetoothText() {
  if (!window.isSecureContext) {
    return 'The page must be opened over <b>https://</b> (or <code>http://localhost</code>) for the browser to allow Bluetooth.';
  }
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    ? 'Safari on iPhone / iPad does not support Web Bluetooth. Open this page in the <b>Bluefy</b> app (App Store).'
    : 'This browser does not support Web Bluetooth. Use <b>Chrome</b> or <b>Edge</b> (Android, Windows, macOS).';
}

/* ------------------------------------------------------------------ render */
function queueRender() {
  if (!ui.renderQueued) {
    ui.renderQueued = true;
    requestAnimationFrame(() => {
      ui.renderQueued = false;
      render();
    });
  }
}

function render() {
  const m = ui.session?.model;
  if (!m) {
    return;
  }
  renderTabs(m);
  $('stats').textContent = `rx ${m.stats.rx} · tx ${m.stats.tx} · multi ${m.stats.multi} · CRC errors ${m.stats.crc}`;
  if (ui.page !== 'Monitor') {
    return;
  }
  // the legacy protocol carries tool registers only
  $('cardTemp').hidden = !!m.legacy;
  $('cardBms').hidden = !!m.legacy;
  const p = m.pcba[ui.pcba];
  const v = pcbaView(p.regs);
  renderRun(v);
  renderInfo(v);
  renderFaults(v, p);
  renderProtect(v);
  renderGpio(v);
  renderTemp(m);
  renderBms(m);
  renderDatalogger(m);
  renderAges();
}

/** Legacy: one PCBA is polled at a time, so the tabs come from the master's PCBA count (reg 5 high byte). */
function legacyPcbaIds(m) {
  const n = Math.min((m.pcba[0].regs[REG.PCBA_NUM] ?? 0) >> 8, MAX_PCBAS);
  return Array.from({ length: Math.max(n, 1) }, (_, i) => i);
}

function renderTabs(m) {
  const ids = m.legacy
    ? legacyPcbaIds(m)
    : m.pcba.map((p, i) => (p.seen.info || p.seen.run ? i : -1)).filter((i) => i >= 0);
  if (!ids.includes(ui.pcba) && ids.length) {
    ui.pcba = ids[0];
    ui.session?.select?.(ui.pcba);
  }
  const lock = chart.recording ? ' disabled title="Stop the chart recording to change PCBA"' : '';
  const html = ids.length > 1
    ? ids.map((i) => `<button type="button" class="btn btn-small ${i === ui.pcba ? 'on' : ''}" data-pcba="${i}"${lock}>`
      + `PCBA ${i} · ${hexv(mapIdToTargetId(i), 2)}</button>`).join('')
    : '';
  const tabs = $('tabs');
  if (tabs.innerHTML !== html) {
    tabs.innerHTML = html;
  }
  tabs.hidden = !html;
}

function renderRun(v) {
  const r = v.run;
  const raw = (prefix, x) => (x != null ? `${prefix} ${x}` : null);
  const smClass = r.sm === 'FAULT' ? 'bad' : (r.sm === 'RUN' ? 'ok' : '');
  $('tiles').innerHTML = [
    tile('Current', val(r.currentA, 1), 'A', raw('AD', r.currentRaw)),
    tile('Voltage', val(r.voltageV, 1), 'V', raw('AD', r.voltageRaw)),
    tile('Power', val(r.powerW, 0), 'W', 'V × I'),
    tile('Temperature', val(r.tempC, 1), '°C', raw('AD', r.tempRaw)),
    tile('Speed', val(r.rpm), 'RPM'),
    tile('Duty', val(r.dutyPct), '%', raw('raw', r.dutyRaw)),
    tile('ADC Pot', val(r.potPct), '%', raw('raw', r.potRaw)),
    tile('Motor_SM', r.sm ?? DASH, '', raw('raw', r.smRaw), smClass),
    tile('FaultCode', r.errorCode == null ? DASH : hexv(r.errorCode, 2), '', null, r.errorCode ? 'bad' : ''),
    tile('Motor Direction', val(r.dir), ''),
  ].join('');
}

function renderInfo(v) {
  const i = v.info;
  $('toolInfo').innerHTML = kv([
    ['PartNumber', val(i.pn)],
    ['FW Version', val(i.fwVersion)],
    ['FW PartNumber', val(i.fwPn)],
    ['Protocol Version', val(i.protocolVersion)],
    ['FW Mode', val(i.fwMode)],
    ['Tool Voltage Kind', i.volType == null ? DASH : `${i.volType} V`],
    ['Tools Num', val(i.toolsNum)],
    ['Target ID', hexv(mapIdToTargetId(ui.pcba), 2)],
    ['MCU_UID', val(i.uid), 'mono'],
    ['Full Duty Value', val(i.fullDuty)],
    ['Current ADC Offset', val(i.currentOffset)],
    ['OP Gain / Shunt', i.opGain == null ? DASH : `${i.opGain} / ${i.shunt}`],
    ['Voltage Divider', val(i.volDiv)],
    ['NTC Type / Div R', i.ntcType == null ? DASH : `${i.ntcType} / ${i.ntcDivR}`],
  ]);
}

function renderFaults(v, p) {
  const h = p.hist;
  $('faults').innerHTML = kv([
    ['FaultCode (now)', v.run.errorCode == null ? DASH : hexv(v.run.errorCode, 2), 'mono'],
    ...[0, 1, 2, 3].map((k) => [`History Error Code${k + 1}`, h ? hexv(h.bytes[k], 2) : DASH, 'mono']),
    ['History (u32)', h ? hexv(h.code, 8) : DASH, 'mono'],
  ]);
}

function renderProtect(v) {
  const rows = v.protect.map((x) => {
    const off = x.en === 0 ? 'off' : '';
    return `<tr><td>${esc(x.name)}</td><td class="${off}">${x.en == null ? DASH : (x.en ? 'ON' : 'OFF')}</td>`
      + `<td class="${off}">${val(x.value)}</td><td class="${off}">${val(x.time)}</td></tr>`;
  }).join('');
  $('protect').innerHTML = '<thead><tr><th>Protection</th><th>Enable</th><th>Value</th><th>Time</th></tr></thead>'
    + `<tbody>${rows}</tbody>`;
}

function renderGpio(v) {
  $('gpio').innerHTML = '<thead><tr><th>Port</th><th>IN (IDR)</th><th>OUT (ODR)</th></tr></thead><tbody>'
    + v.gpio.map((g) => `<tr><td>GPIO${g.port}</td><td class="mono">${g.in ?? DASH}</td><td class="mono">${g.out ?? DASH}</td></tr>`).join('')
    + '</tbody>';
  const withSigned = (x) => (x == null ? DASH : `${x} (${x & 0x8000 ? x - 0x10000 : x})`);
  $('debug').innerHTML = kv([
    ['Debug Data1', withSigned(v.run.debug1)],
    ['Debug Data2', withSigned(v.run.debug2)],
  ]);
}

function renderTemp(m) {
  if (!m.temp) {
    $('temp').innerHTML = '<p class="muted">No temperature data yet.</p>';
    return;
  }
  // CH0 is logged in mV by the firmware (uV / 1000), CH1..5 in degC
  $('temp').innerHTML = m.temp.map((c, i) => (i === 0
    ? tile('CH0', val(c.uV / 1000, 3), 'mV', `${c.uV} µV`)
    : tile(`CH${i}`, c.burnout ? 'burnout' : val(c.tempX10 / 10, 1), c.burnout ? '' : '°C', `${c.uV} µV`, c.burnout ? 'bad' : ''))).join('');
}

function renderBms(m) {
  if (m.bms40) {
    const b = m.bms40;
    $('bms').innerHTML = kv([
      ['SOC', `${val(b.socPct, 1)} %`],
      ['Voltage', `${val(b.voltageV, 1)} V`],
      ['Current', `${val(b.currentA, 1)} A`],
      ['Cell temp', `${b.cellTempLog}  (raw ${b.cellTemp} − 300, as in the SD log)`],
      ['Warning state', hexv(b.warning), 'mono'],
      ['Charge / Discharge', `${hexv(b.charge, 2)} / ${hexv(b.discharge, 2)}`, 'mono'],
      ['HW PN / version', `${b.hwPn} / ${b.hwMajor}.${b.hwMinor}`],
      ['FW PN / version', `${b.fwPn} / ${b.fwMajor}.${b.fwMinor}.${b.fwPatch}`],
    ]);
  } else if (m.bat18) {
    const b = m.bat18;
    $('bms').innerHTML = kv([
      ['Pack', `${b.series}S${b.parallel}P, ${b.capacityMah} mAh`],
      ['Current', val(b.current)],
      ['Pack temp', val(b.temp)],
      ['Fuel gauge LEDs', val(b.fuelLeds)],
      ['Pack mode', val(b.mode)],
      ['FW / HW', `${b.fw} / V${b.hw}`],
    ]);
  } else {
    $('bms').innerHTML = '<dt>Battery</dt><dd class="muted">No battery data yet.</dd>';
  }
}

function renderDatalogger(m) {
  if (m.legacy) {
    renderLegacyDatalogger(m.legacy);
    return;
  }
  const i = m.info;
  $('dl').innerHTML = kv([
    ['FW Version', i ? `V${i.fwVersion}` : DASH],
    ['Protocol Version', i ? i.protocolVersion : (m.handshake?.protocolVersion ?? DASH)],
    ['MCU_UID', i ? i.uid : DASH, 'mono'],
    ['Tool Bootloader', i ? (i.toolBootMode ? 'Boot mode' : 'Normal') : DASH],
    ['PayLoad Size', val(m.payloadSize)],
    ['Bus Voltage', m.selfVI ? `${val(m.selfVI.vX10 / 10, 1)} V` : DASH],
    ['Bus Current', m.selfVI ? `${val(m.selfVI.iX10 / 10, 1)} A` : DASH],
    ['BLE', ui.link?.name || DASH],
  ]);
}

/** Status byte of the legacy answer (app_ble.c BLE_Tx_Buff[66]). */
function renderLegacyDatalogger(L) {
  const s = L.status;
  const bit = (n) => (s == null ? null : (s >> n) & 1);
  const yesNo = (b, yes, no) => (b == null ? DASH : (b ? yes : no));
  $('dl').innerHTML = kv([
    ['Protocol', 'Legacy 20-byte (FW V4.x / APK)'],
    ['FW date', val(L.fwDate)],
    ['Tool bus', yesNo(bit(0), 'answering', 'no answer'), bit(0) === 0 ? 'bad' : ''],
    ['Tool Bootloader', yesNo(bit(2), 'Boot mode', 'Normal')],
    ['TF card', s == null ? DASH : (bit(3) ? (bit(4) ? 'inserted, logging' : 'inserted') : 'not inserted')],
    ['Polled target ID', hexv(L.busTargetId, 2)],
    ['Status byte', hexv(s, 2), 'mono'],
    ['Missed answers', String(L.misses), L.misses ? 'bad' : ''],
    ['BLE', ui.link?.name || DASH],
  ]);
}

function renderAges() {
  const m = ui.session?.model;
  if (!m) {
    return;
  }
  const p = m.pcba[ui.pcba];
  const seen = {
    run: p.seen.run, info: p.seen.info, protect: p.seen.protect, hist: p.seen.hist,
    temp: m.seen.temp, bms: m.seen.bms, dl: Math.max(m.seen.info, m.seen.selfVI),
  };
  const now = Date.now();
  document.querySelectorAll('[data-age]').forEach((el) => {
    const ts = seen[el.dataset.age];
    if (!ts) {
      el.textContent = 'no data';
      el.classList.remove('stale');
      return;
    }
    const s = Math.round((now - ts) / 1000);
    el.textContent = s < 1 ? 'just now' : `${s} s ago`;
    el.classList.toggle('stale', el.dataset.age === 'run' && now - ts > STALE_MS);
  });
}

/* ------------------------------------------------------------------ frame log */
function onLog(e) {
  if (ui.logPaused || !$('logBox').open) {
    return;
  }
  const { t, kind, text } = e.detail;
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = `${new Date(t).toISOString().slice(11, 23)} ${kind.toUpperCase().padEnd(3)} ${text}`;
  const log = $('log');
  log.appendChild(line);
  while (log.childElementCount > LOG_LINES) {
    log.firstChild.remove();
  }
  log.scrollTop = log.scrollHeight;
}

async function copyLog() {
  const btn = $('btnCopyLog');
  const text = (ui.session?.log || [])
    .map((x) => `${new Date(x.t).toISOString()} ${x.kind} ${x.text}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

/* ------------------------------------------------------------------ old offline copy */
/**
 * Versions up to 0.3.0 installed a service worker with an offline cache. The page is now always
 * loaded from the server, so any worker and cache left by those versions are removed.
 */
async function removeOfflineCopy() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = window.caches ? await caches.keys() : [];
    await Promise.all(keys.filter((k) => k.startsWith(OLD_CACHE_PREFIX)).map((k) => caches.delete(k)));
  } catch {
    /* nothing to clean or storage blocked */
  }
}

/* ------------------------------------------------------------------ pages */
/** Monitor or Chart; the PCBA tabs and the frame log are shared by both. */
function showPage(name) {
  ui.page = name;
  document.querySelectorAll('#pages [data-page]').forEach((b) => b.classList.toggle('on', b.dataset.page === name));
  $('pageMonitor').hidden = name !== 'Monitor';
  $('pageChart').hidden = name !== 'Chart';
  chart.show(name === 'Chart');
  render();
}

const chart = new ChartPage({
  getSession: () => ui.session,
  getPcba: () => ui.pcba,
  deviceName: () => ui.link?.name,
  pcbaLabel: (mapId) => `PCBA ${mapId} · ${hexv(mapIdToTargetId(mapId), 2)}`,
  onRecording: () => queueRender(),        // re-renders the PCBA tabs (locked while recording)
});

/* ------------------------------------------------------------------ init */
function init() {
  $('ver').textContent = `v${self.APP_VERSION}`;
  removeOfflineCopy();
  $('btnConnect').addEventListener('click', onConnectClick);
  $('btnCopyLog').addEventListener('click', copyLog);
  $('optPause').addEventListener('change', (e) => { ui.logPaused = e.target.checked; });
  $('pages').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) {
      showPage(b.dataset.page);
    }
  });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pcba]');
    if (b && !chart.recording) {
      ui.pcba = Number(b.dataset.pcba);
      ui.session?.select?.(ui.pcba);        // legacy: poll this PCBA from now on
      render();
    }
  });
  setInterval(renderAges, 1000);
  if (!bluetoothAvailable()) {
    showBanner(noBluetoothText());
  }
}

init();
