/**
 * Web Bluetooth transport for the datalogger BLE module (transparent UART service 0xFFF0,
 * one notify characteristic = device -> app, one write characteristic = app -> device;
 * the Android APK uses 0xFFF1 / 0xFFF2).
 *
 * Events: 'data' (detail: Uint8Array), 'state' (detail: 'connecting'|'connected'|'disconnected').
 */

/* Full 128-bit strings: some iOS WebKit based browsers (Bluefy) do not accept the numeric
 * 16-bit aliases that Chrome takes. */
const uuid128 = (short) => `0000${short}-0000-1000-8000-00805f9b34fb`;
export const SERVICE_UUID = uuid128('fff0');
export const RX_UUID = uuid128('fff1');
export const TX_UUID = uuid128('fff2');
export const NAME_PREFIX = 'Debugger';

/** Largest write we send in one GATT operation: the firmware parses one UART chunk per frame. */
const MAX_WRITE = 20;

export function bluetoothAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export class BleLink extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.queue = Promise.resolve();
    this.onNotify = (e) => {
      const v = e.target.value;
      this.emit('data', new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    };
    this.onDisconnect = () => {
      this.rx = null;
      this.tx = null;
      this.emit('state', 'disconnected');
    };
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get name() {
    return this.device?.name || '';
  }

  get connected() {
    return !!this.device?.gatt?.connected && !!this.tx;
  }

  /** Opens the browser device chooser (must be called from a user gesture). */
  async choose({ showAll = false } = {}) {
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : { filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE_UUID] };
    const device = await step('choose device', navigator.bluetooth.requestDevice(opts));
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnect);
    return device;
  }

  /** Connects (or reconnects) to the chosen device. */
  async connect() {
    if (!this.device) {
      throw new Error('no device chosen');
    }
    this.emit('state', 'connecting');
    try {
      const server = await step('GATT connect', this.device.gatt.connect());
      const service = await step('find service FFF0', server.getPrimaryService(SERVICE_UUID));
      // direct lookup first (what the APK uses), scan by properties only as a fallback
      this.rx = await service.getCharacteristic(RX_UUID).catch(() => null);
      this.tx = await service.getCharacteristic(TX_UUID).catch(() => null);
      if (!this.rx || !this.tx) {
        const chars = await step('list characteristics', service.getCharacteristics());
        const props = (c) => c.properties || {};
        this.rx = this.rx || chars.find((c) => props(c).notify || props(c).indicate) || null;
        this.tx = this.tx || chars.find((c) => props(c).write || props(c).writeWithoutResponse) || null;
      }
      if (!this.rx || !this.tx) {
        throw new Error('[find characteristics] FFF1 (notify) / FFF2 (write) not found');
      }
      this.rx.addEventListener('characteristicvaluechanged', this.onNotify);
      await step('enable notify FFF1', this.rx.startNotifications());
      this.emit('state', 'connected');
    } catch (err) {
      this.rx = null;
      this.tx = null;
      if (this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
      this.emit('state', 'disconnected');
      throw err;
    }
  }

  disconnect() {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();          // fires gattserverdisconnected
    }
  }

  /** Serialized writes (Web Bluetooth rejects overlapping GATT operations). */
  write(bytes) {
    const job = this.queue.then(async () => {
      if (!this.tx) {
        throw new Error('not connected');
      }
      for (let o = 0; o < bytes.length; o += MAX_WRITE) {
        const part = bytes.slice(o, o + MAX_WRITE);
        if (this.tx.properties?.writeWithoutResponse && this.tx.writeValueWithoutResponse) {
          await this.tx.writeValueWithoutResponse(part);
        } else if (this.tx.writeValueWithResponse) {
          await this.tx.writeValueWithResponse(part);
        } else {
          await this.tx.writeValue(part);
        }
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

/** Readable text for any rejection value (Bluefy may reject with a bare number). */
export function describeError(err) {
  if (err == null) {
    return 'unknown';
  }
  if (typeof err !== 'object') {
    return `code ${String(err)}`;
  }
  const parts = [err.name, err.message, err.code != null ? `code ${err.code}` : null].filter(Boolean);
  return parts.length ? parts.join(': ') : JSON.stringify(err);
}

/** Tags a failure with the step it happened in. */
async function step(label, promise) {
  try {
    return await promise;
  } catch (err) {
    const e = new Error(`[${label}] ${describeError(err)}`);
    e.name = err?.name || 'Error';
    e.cause = err;
    throw e;
  }
}
