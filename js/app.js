/**
 * UI of the Datalogger BLE Monitor (display only).
 */
import { BleLink, bluetoothAvailable, describeError } from './ble.js';
import { SimLink } from './sim.js';
import { Session } from './session.js';
import { mapIdToTargetId, pcbaView } from './decode.js';

const $ = (id) => document.getElementById(id);
const RECONNECT_TRIES = 5;
const STALE_MS = 5000;

const ui = {
  link: null,
  session: null,
  wanted: false,           // user wants to stay connected (auto reconnect)
  reconnecting: false,
  demo: false,
  pcba: 0,
  renderQueued: false,
  logPaused: false,
};

/* ------------------------------------------------------------------ helpers */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dash = '–';
const val = (v, digits) => (v == null || Number.isNaN(v) ? dash : (digits == null ? String(v) : Number(v).toFixed(digits)));
const hexv = (v, w = 4) => (v == null ? dash : `0x${v.toString(16).toUpperCase().padStart(w, '0')}`);

function kv(rows) {
  return rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls || ''}">${esc(v)}</dd>`).join('');
}

function tile(label, value, unit, raw, cls = '') {
  return `<div class="tile ${cls}"><div class="k">${esc(label)}</div>`
    + `<div class="v">${esc(value)}${unit && value !== dash ? `<small>${esc(unit)}</small>` : ''}</div>`
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
      showBanner(`Không kết nối được: <code>${esc(describeError(err))}</code><br>`
        + 'Thử: tắt/bật Bluetooth trên điện thoại, kiểm tra datalogger không đang nối với máy khác (APK, PC), '
        + 'hoặc bật tuỳ chọn <b>Hiện mọi thiết bị BLE</b> rồi kết nối lại.');
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
  setStatus('Đang bắt tay…', 'busy');
  try {
    await s.start();
    setStatus(`${ui.link.name || 'Đã kết nối'}${ui.demo ? ' (demo)' : ''}`, 'on');
    $('empty').hidden = true;
    $('view').hidden = false;
    queueRender();
  } catch (err) {
    setStatus('Lỗi giao tiếp', 'busy');
    showBanner(`Thiết bị không trả lời: <code>${esc(describeError(err))}</code>. Kiểm tra datalogger đang bật và thử kết nối lại.`);
  }
}

function onLinkState(e) {
  const st = e.detail;
  $('btnConnect').textContent = st === 'disconnected' ? 'Kết nối' : 'Ngắt';
  if (st === 'connecting') {
    setStatus('Đang kết nối…', 'busy');
  } else if (st === 'disconnected') {
    ui.session?.stop();
    setStatus('Chưa kết nối', 'off');
    if (ui.wanted && !ui.demo && !ui.reconnecting) {
      reconnect().finally(() => { ui.reconnecting = false; });
    }
  }
}

async function reconnect() {
  ui.reconnecting = true;
  for (let i = 1; i <= RECONNECT_TRIES && ui.wanted; i++) {
    setStatus(`Kết nối lại ${i}/${RECONNECT_TRIES}…`, 'busy');
    await new Promise((r) => setTimeout(r, 1500));
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
    setStatus('Mất kết nối', 'off');
    showBanner('Mất kết nối với thiết bị. Bấm <b>Kết nối</b> để chọn lại.');
  }
}

function noBluetoothText() {
  if (!window.isSecureContext) {
    return 'Trang phải mở qua <b>https://</b> (hoặc <code>http://localhost</code>) thì trình duyệt mới cho dùng Bluetooth.';
  }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return ios
    ? 'Safari trên iPhone/iPad không hỗ trợ Web Bluetooth. Mở trang này bằng app <b>Bluefy</b> (App Store).'
    : 'Trình duyệt này không hỗ trợ Web Bluetooth. Dùng <b>Chrome</b> hoặc <b>Edge</b> (Android, Windows, macOS). Vẫn có thể bấm <b>Demo</b>.';
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
  renderInfo(v, p);
  renderFaults(v, p);
  renderProtect(v);
  renderGpio(v);
  renderTemp(m);
  renderBms(m);
  renderDl(m);
  renderAges();
  $('stats').textContent = `rx ${m.stats.rx} · tx ${m.stats.tx} · multi ${m.stats.multi} · CRC lỗi ${m.stats.crc}`;
}

function renderTabs(m) {
  const ids = m.pcba.map((p, i) => (p.seen.info || p.seen.run ? i : -1)).filter((i) => i >= 0);
  if (!ids.includes(ui.pcba) && ids.length) {
    ui.pcba = ids[0];
  }
  const html = ids.length > 1
    ? ids.map((i) => `<button type="button" class="btn btn-small ${i === ui.pcba ? 'on' : ''}" data-pcba="${i}">PCBA ${i} · ${hexv(mapIdToTargetId(i), 2)}</button>`).join('')
    : '';
  const tabs = $('tabs');
  if (tabs.innerHTML !== html) {
    tabs.innerHTML = html;
  }
  tabs.hidden = !html;
}

function renderRun(v) {
  const r = v.run;
  const fault = r.errorCode != null && r.errorCode !== 0;
  $('tiles').innerHTML = [
    tile('Current', val(r.currentA, 1), 'A', r.currentRaw != null ? `AD ${r.currentRaw}` : null),
    tile('Voltage', val(r.voltageV, 1), 'V', r.voltageRaw != null ? `AD ${r.voltageRaw}` : null),
    tile('Power', val(r.powerW, 0), 'W', 'V × I'),
    tile('Temperature', val(r.tempC, 1), '°C', r.tempRaw != null ? `AD ${r.tempRaw}` : null),
    tile('Speed', val(r.rpm), 'RPM'),
    tile('Duty', val(r.dutyPct), '%', r.dutyRaw != null ? `raw ${r.dutyRaw}` : null),
    tile('ADC Pot', val(r.potPct), '%', r.potRaw != null ? `raw ${r.potRaw}` : null),
    tile('Motor_SM', r.sm ?? dash, '', r.smRaw != null ? `raw ${r.smRaw}` : null, r.sm === 'FAULT' ? 'bad' : (r.sm === 'RUN' ? 'ok' : '')),
    tile('FaultCode', r.errorCode == null ? dash : hexv(r.errorCode, 2), '', null, fault ? 'bad' : ''),
    tile('Motor Direction', val(r.dir), ''),
  ].join('');
}

function renderInfo(v, p) {
  const i = v.info;
  $('toolInfo').innerHTML = kv([
    ['PartNumber', val(i.pn)],
    ['FW Version', val(i.fwVersion)],
    ['FW PartNumber', val(i.fwPn)],
    ['Protocol Version', val(i.protocolVersion)],
    ['FW Mode', val(i.fwMode)],
    ['Tool Voltage Kind', i.volType == null ? dash : `${i.volType} V`],
    ['Tools Num', val(i.toolsNum)],
    ['Target ID', hexv(mapIdToTargetId(ui.pcba), 2)],
    ['MCU_UID', val(i.uid), 'mono'],
    ['Full Duty Value', val(i.fullDuty)],
    ['Current ADC Offset', val(i.currentOffset)],
    ['OP Gain / Shunt', i.opGain == null ? dash : `${i.opGain} / ${i.shunt}`],
    ['Voltage Divider', val(i.volDiv)],
    ['NTC Type / Div R', i.ntcType == null ? dash : `${i.ntcType} / ${i.ntcDivR}`],
  ]);
}

function renderFaults(v, p) {
  const h = p.hist;
  $('faults').innerHTML = kv([
    ['FaultCode (now)', v.run.errorCode == null ? dash : hexv(v.run.errorCode, 2), 'mono'],
    ...[0, 1, 2, 3].map((k) => [`History Error Code${k + 1}`, h ? hexv(h.bytes[k], 2) : dash, 'mono']),
    ['History (u32)', h ? hexv(h.code, 8) : dash, 'mono'],
  ]);
}

function renderProtect(v) {
  const rows = v.protect.map((x) => {
    const off = x.en === 0;
    return `<tr><td>${esc(x.name)}</td><td class="${off ? 'off' : ''}">${x.en == null ? dash : (x.en ? 'ON' : 'OFF')}</td>`
      + `<td class="${off ? 'off' : ''}">${val(x.value)}</td><td class="${off ? 'off' : ''}">${val(x.time)}</td></tr>`;
  }).join('');
  $('protect').innerHTML = `<thead><tr><th>Bảo vệ</th><th>Enable</th><th>Value</th><th>Time</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderGpio(v) {
  $('gpio').innerHTML = '<thead><tr><th>Port</th><th>IN (IDR)</th><th>OUT (ODR)</th></tr></thead><tbody>'
    + v.gpio.map((g) => `<tr><td>GPIO${g.port}</td><td class="mono">${g.in ?? dash}</td><td class="mono">${g.out ?? dash}</td></tr>`).join('')
    + '</tbody>';
  const s16 = (x) => (x == null ? dash : `${x} (${x & 0x8000 ? x - 0x10000 : x})`);
  $('debug').innerHTML = kv([
    ['Debug Data1', s16(v.run.debug1)],
    ['Debug Data2', s16(v.run.debug2)],
  ]);
}

function renderTemp(m) {
  if (!m.temp) {
    $('temp').innerHTML = `<p class="muted">Chưa nhận dữ liệu nhiệt độ.</p>`;
    return;
  }
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
      ['Cell temp', `${b.cellTempLog}  (raw ${b.cellTemp} − 300, như log SD)`],
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
    $('bms').innerHTML = `<dt>Pin</dt><dd class="muted">Chưa nhận dữ liệu pin.</dd>`;
  }
}

function renderDl(m) {
  const i = m.info;
  $('dl').innerHTML = kv([
    ['FW Version', i ? `V${i.fwVersion}` : dash],
    ['Protocol Version', i ? i.protocolVersion : (m.handshake?.protocolVersion ?? dash)],
    ['MCU_UID', i ? i.uid : dash, 'mono'],
    ['Tool Bootloader', i ? (i.toolBootMode ? 'Boot mode' : 'Normal') : dash],
    ['PayLoad Size', val(m.payloadSize)],
    ['Bus Voltage', m.selfVI ? `${val(m.selfVI.vX10 / 10, 1)} V` : dash],
    ['Bus Current', m.selfVI ? `${val(m.selfVI.iX10 / 10, 1)} A` : dash],
    ['BLE', ui.link?.name || dash],
  ]);
}

function renderAges() {
  const m = ui.session?.model;
  if (!m) {
    return;
  }
  const p = m.pcba[ui.pcba];
  const t = {
    run: p.seen.run, info: p.seen.info, protect: p.seen.protect, hist: p.seen.hist,
    temp: m.seen.temp, bms: m.seen.bms, dl: Math.max(m.seen.info, m.seen.selfVI),
  };
  const now = Date.now();
  document.querySelectorAll('[data-age]').forEach((el) => {
    const ts = t[el.dataset.age];
    if (!ts) {
      el.textContent = 'chưa có';
      el.classList.remove('stale');
      return;
    }
    const s = Math.round((now - ts) / 1000);
    el.textContent = s < 1 ? 'vừa xong' : `${s} s trước`;
    el.classList.toggle('stale', el.dataset.age === 'run' && now - ts > STALE_MS);
  });
}

/* ------------------------------------------------------------------ log */
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
  while (log.childElementCount > 300) {
    log.firstChild.remove();
  }
  log.scrollTop = log.scrollHeight;
}

async function copyLog() {
  const text = (ui.session?.log || [])
    .map((x) => `${new Date(x.t).toISOString()} ${x.kind} ${x.text}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('btnCopyLog').textContent = 'Đã copy';
  } catch {
    $('btnCopyLog').textContent = 'Không copy được';
  }
  setTimeout(() => { $('btnCopyLog').textContent = 'Copy'; }, 1500);
}

/* ------------------------------------------------------------------ PWA */
function setupPwa() {
  $('ver').textContent = `v${self.APP_VERSION}`;
  const net = () => { $('net').textContent = navigator.onLine ? 'online' : 'offline'; };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();

  const offline = $('offline');
  if (!('serviceWorker' in navigator) || !window.caches) {
    offline.textContent = 'trình duyệt không hỗ trợ lưu offline';
    return;
  }
  offline.textContent = 'đang lưu offline…';
  const checkSaved = async () => {
    try {
      const has = (await caches.keys()).includes(`dl-ble-monitor-${self.APP_VERSION}`);
      offline.textContent = has ? '✓ đã lưu offline' : 'đang lưu offline…';
      return has;
    } catch {
      offline.textContent = 'không lưu offline được';
      return true;
    }
  };
  let swReady = false;
  navigator.serviceWorker.ready.then(async () => {
    swReady = true;
    for (let i = 0; i < 20 && !(await checkSaved()); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
  });
  setTimeout(() => {
    if (!swReady) {
      offline.textContent = '✗ chưa lưu offline được (trình duyệt có thể không hỗ trợ)';
    }
  }, 15000);
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => {
      $('update').hidden = false;
      $('btnReload').onclick = () => w.postMessage('skipWaiting');
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
    offline.textContent = 'không lưu offline được';
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) {
      reloading = true;
      location.reload();
    }
  });
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
