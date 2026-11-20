/**
 * UI of the Datalogger BLE Monitor (display only).
 */
import { BleLink, bluetoothAvailable, describeError } from './ble.js';
import { SimLink } from './sim.js';
import { Session } from './session.js';
import { mapIdToTargetId, pcbaView } from './decode.js';

const $ = (id) => document.getElementById(id);

const RECONNECT_TRIES = 5;
const RECONNECT_DELAY_MS = 1500;
const STALE_MS = 5000;
const LOG_LINES = 300;
const CACHE_PREFIX = 'dl-ble-monitor-';        // same as sw.js
const SW_READY_TIMEOUT_MS = 15000;

const ui = {
  link: null,
  session: null,
  wanted: false,           // the user wants to stay connected (auto reconnect)
  reconnecting: false,
  demo: false,
  pcba: 0,
  renderQueued: false,
  logPaused: false,
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
    useLink(link, false);
    await startLink();
  } catch (err) {
    if (err?.name !== 'NotFoundError') {                    // NotFoundError = chooser cancelled
      showBanner(`Connection failed: <code>${esc(describeError(err))}</code><br>`
        + 'Try: turn Bluetooth off and on, make sure the datalogger is not connected to another device '
        + '(APK, PC tool), or enable <b>Show all BLE devices</b> and connect again.');
      console.error(err);
    }
  }
}

async function onDemoClick() {
  if (ui.link) {
    ui.wanted = false;
    ui.link.disconnect();
  }
  useLink(new SimLink({ pcbaCount: 2, payloadCap: 60 }), true);
  await startLink();
}

function useLink(link, demo) {
  if (ui.link && ui.link !== link) {
    ui.link.removeEventListener('state', onLinkState);
    ui.session?.dispose();
    ui.session = null;
  }
  if (ui.link !== link) {
    link.addEventListener('state', onLinkState);
  }
  ui.link = link;
  ui.demo = demo;
}

async function startLink() {
  ui.wanted = true;
  showBanner('');
  await ui.link.connect();
  await startSession();
}

async function startSession() {
  ui.session?.dispose();
  const s = new Session(ui.link, { syncTime: $('optTime').checked && !ui.demo });
  ui.session = s;
  s.addEventListener('update', queueRender);
  s.addEventListener('log', onLog);
  setStatus('Handshaking…', 'busy');
  try {
    await s.start();
    setStatus(`${ui.link.name || 'Connected'}${ui.demo ? ' (demo)' : ''}`, 'on');
    $('empty').hidden = true;
    $('view').hidden = false;
    queueRender();
  } catch (err) {
    setStatus('No response', 'busy');
    showBanner(`The device does not answer: <code>${esc(describeError(err))}</code>. `
      + 'Check that the datalogger is powered and connect again.');
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
    if (ui.wanted && !ui.demo && !ui.reconnecting) {
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
    : 'This browser does not support Web Bluetooth. Use <b>Chrome</b> or <b>Edge</b> (Android, Windows, macOS). <b>Demo</b> still works.';
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
  $('stats').textContent = `rx ${m.stats.rx} · tx ${m.stats.tx} · multi ${m.stats.multi} · CRC errors ${m.stats.crc}`;
}

function renderTabs(m) {
  const ids = m.pcba.map((p, i) => (p.seen.info || p.seen.run ? i : -1)).filter((i) => i >= 0);
  if (!ids.includes(ui.pcba) && ids.length) {
    ui.pcba = ids[0];
  }
  const html = ids.length > 1
    ? ids.map((i) => `<button type="button" class="btn btn-small ${i === ui.pcba ? 'on' : ''}" data-pcba="${i}">`
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

/* ------------------------------------------------------------------ PWA */
function setupNetworkStatus() {
  const show = () => { $('net').textContent = navigator.onLine ? 'online' : 'offline'; };
  window.addEventListener('online', show);
  window.addEventListener('offline', show);
  show();
}

/** Shows whether the offline copy of this version is in the cache. */
function watchOfflineCache() {
  const label = $('offline');
  let ready = false;
  label.textContent = 'saving for offline…';
  navigator.serviceWorker.ready.then(async () => {
    ready = true;
    for (let i = 0; i < 20; i++) {
      try {
        if ((await caches.keys()).includes(CACHE_PREFIX + self.APP_VERSION)) {
          label.textContent = '✓ available offline';
          return;
        }
      } catch {
        break;
      }
      await sleep(500);
    }
    label.textContent = '✗ not saved for offline';
  });
  setTimeout(() => {
    if (!ready) {
      label.textContent = '✗ not saved for offline (browser may not support it)';
    }
  }, SW_READY_TIMEOUT_MS);
}

/** Registers sw.js and offers "reload" when a new version is installed. */
function registerServiceWorker() {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => {
      $('update').hidden = false;
      $('btnReload').onclick = () => worker.postMessage('skipWaiting');
    };
    if (reg.waiting && navigator.serviceWorker.controller) {
      offer(reg.waiting);
    }
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          offer(w);
        }
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60000);
  }).catch(() => {
    $('offline').textContent = '✗ not saved for offline';
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) {
      reloading = true;
      location.reload();
    }
  });
}

function setupPwa() {
  $('ver').textContent = `v${self.APP_VERSION}`;
  setupNetworkStatus();
  if (!('serviceWorker' in navigator) || !window.caches) {
    $('offline').textContent = 'offline not supported by this browser';
    return;
  }
  watchOfflineCache();
  registerServiceWorker();
}

/* ------------------------------------------------------------------ init */
function init() {
  setupPwa();
  $('btnConnect').addEventListener('click', onConnectClick);
  $('btnDemo').addEventListener('click', onDemoClick);
  $('btnCopyLog').addEventListener('click', copyLog);
  $('optPause').addEventListener('change', (e) => { ui.logPaused = e.target.checked; });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pcba]');
    if (b) {
      ui.pcba = Number(b.dataset.pcba);
      render();
    }
  });
  setInterval(renderAges, 1000);
  if (!bluetoothAvailable()) {
    showBanner(noBluetoothText());
  }
  if (new URLSearchParams(location.search).has('demo')) {
    onDemoClick();
  }
}

init();
