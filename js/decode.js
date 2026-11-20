/**
 * Payload decoding and unit conversion, copied from the firmware so the web shows
 * exactly what the datalogger computes:
 *   register map      : Core/Inc/app_ttech.h (REG_*_INDEX)
 *   push payloads     : Core/Src/app_np_ble.c (Send_*_To_PC, Pack_*_Response)
 *   current / voltage : Core/Src/app_end_of_line_test.c (Calc_AD_To_X10I / X10V)
 *   PCBA NTC          : Core/Src/app_end_of_line_test.c (TempAD_XAxis / TempX10_YAxis)
 * All C integer divisions are reproduced with Math.trunc, uint32 / uint16 wraps included.
 */
import { readU16, readS16, readU32, readS32 } from './protocol.js';

export const T_TECH_PV_3P1 = 769;    // app.h T_TECH_PV_3PIONT1
export const T_TECH_PV_3P3 = 771;    // app.h T_TECH_PV_3PIONT3
export const MAX_PCBAS = 7;

/** Register index, app_ttech.h */
export const REG = Object.freeze({
  PN_LOW: 0, PN_HIGH: 1, PTCL_VERSION: 2, FW_VERSION: 3, FW_MODE: 4, PCBA_NUM: 5,
  UID_5: 6, PCBA_VOL: 7, FULL_DUTY: 8, CURRENT_OFFSET: 9,
  UID_0: 10, UID_1: 11, UID_2: 12, UID_3: 13, UID_4: 14,
  FW_PN_LOW: 15, FW_PN_HIGH: 16, OP_GAIN: 17, SHUNT: 18, VOL_DIV: 19, NTC_TYPE: 20, NTC_DIV_R: 21,

  MOTOR_SM: 32, ERROR_CODE: 33, MOTOR_SPEED: 34, CURRENT: 35, VOLTAGE: 36, PCBA_TEMP: 37,
  POT: 38, PWM_DUTY: 39, DEBUG_DATA1: 40, DEBUG_DATA2: 41, MOTOR_DIR: 42,
  GPIOA_IDR: 43, GPIOA_ODR: 44, GPIOB_IDR: 45, GPIOB_ODR: 46, GPIOC_IDR: 47, GPIOC_ODR: 48,
  GPIOD_IDR: 49, GPIOD_ODR: 50, GPIOE_IDR: 51, GPIOE_ODR: 52, GPIOF_IDR: 53, GPIOF_ODR: 54,

  EN_CONTROL: 128, EN_SPEEDSET: 129, EN_DUTYSET: 130,
  JAM_PROTECT_EN: 173,
});

/** Protection triplets (enable, value, time) from REG_CURRENT_LIMIT_EN_INDEX = 131. */
export const PROTECTIONS = Object.freeze([
  'CurrentLimit', 'OCP1', 'OCP2', 'OCP3', 'OCP4', 'OCP5',
  'OVP', 'UVP', 'OTP', 'UTP', 'OSP', 'USP', 'O15VP', 'U15VP',
].map((name, i) => ({ name, en: 131 + 3 * i, value: 132 + 3 * i, time: 133 + 3 * i })));

export const MOTOR_SM = Object.freeze(['INIT', 'IDLE', 'RUN', 'BRAKE', 'STOP', 'FAULT']);   // app_ttech.c

const u32 = (v) => ((v % 4294967296) + 4294967296) % 4294967296;
const u16 = (v) => u32(v) & 0xFFFF;
const div = (a, b) => Math.trunc(a / b);

/* ------------------------------------------------------------------ conversions */
/** Calc_AD_To_X10I: tool current x10 A. */
export function adToX10I(ad, { pv, pn, offset, opGain, shunt }) {
  if (ad < offset) {
    return 0;
  }
  const d = u32(ad - offset);
  let r;
  if (pv < T_TECH_PV_3P3) {
    const k = (pn !== 282220001) ? 1000 : 2000;
    r = div(div(u32(u32(d * k) * 330 * 10), 4096), 1100);
  } else {
    const s = shunt || 10;
    const g = opGain || 1100;
    r = div(div(u32(u32(div(u32(d * 10000), s) * 330) * 10), 4096), g);
  }
  return u16(r);
}

/** Calc_AD_To_X10V: tool voltage x10 V. */
export function adToX10V(ad, { pv, volType, divider }) {
  let r;
  if (pv < T_TECH_PV_3P3) {
    if (volType === 18) {
      r = div(div(u32(ad * (68 + 68 + 20) * 33), 4096), 20);
    } else if (volType === 80) {
      r = div(div(u32(ad * (680 + 680 + 56) * 33), 4096), 56);
    } else {
      r = div(div(u32(ad * (68 + 68 + 10) * 33), 4096), 10);
    }
  } else {
    r = div(div(div(u32(u32(ad * 10 * divider) * 33), 10), 4096), 100);
  }
  return u16(r);
}

const TEMP_AD_X = [191, 248, 319, 405, 508, 628, 766, 919, 1087, 1267, 1457, 1653, 1852, 2048,
  2239, 2422, 2593, 2752, 2898, 3031, 3150, 3256, 3352, 3436, 3511, 3577, 3635, 3687, 3732,
  3771, 3806, 3837, 3863, 3887];
const TEMP_X10_Y = [-400, -350, -300, -250, -200, -150, -100, -50, 0, 50, 100, 150, 200, 250,
  300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100, 1150,
  1200, 1250];

/** Math_LUT_1D(TempAD_XAxis, TempX10_YAxis, 33): PCBA NTC x10 degC. */
export function ntcAdToX10Degree(ad) {
  const max = 33;
  const x = (ad << 16) >> 16;                  // (int16_t)ad
  let left;
  let frac;
  if (x <= TEMP_AD_X[0]) {
    left = 0;
    frac = 0;
  } else if (x < TEMP_AD_X[max]) {
    let lo = 0;
    let hi = max;
    let mid = max >> 1;
    while (hi - lo > 1) {
      if (x < TEMP_AD_X[mid]) {
        hi = mid;
      } else {
        lo = mid;
      }
      mid = (hi + lo) >> 1;
    }
    left = lo;
    frac = div(u32(((x - TEMP_AD_X[left]) & 0xFFFF) * 65536), (TEMP_AD_X[left + 1] - TEMP_AD_X[left]) & 0xFFFF) & 0xFFFF;
  } else {
    left = max;
    frac = 0;
  }
  if (left === max) {
    return TEMP_X10_Y[left];
  }
  return ((((TEMP_X10_Y[left + 1] - TEMP_X10_Y[left]) * frac) >> 16) + TEMP_X10_Y[left]) << 16 >> 16;
}

/* ------------------------------------------------------------------ payloads */
/** 0x004 response: Pack_Datalogger_Info_Response. */
export function decodeDataloggerInfo(d) {
  if (d.length < 17) {
    return null;
  }
  const uid = [readU32(d, 5), readU32(d, 9), readU32(d, 13)];
  return {
    fwVersion: `${d[1]}.${d[0]}`,
    protocolVersion: `${d[3]}.${d[2]}`,
    toolBootMode: d[4] === 0,                  // 0 = tool in boot mode, 1 = normal
    uid: uid.map((w) => w.toString(16).toUpperCase().padStart(8, '0')).join('-'),
  };
}

/** 0x001 response: Pack_HandShake_Response. */
export function decodeHandshake(d) {
  return d.length >= 3 ? { status: d[0], protocolVersion: `${d[2]}.${d[1]}` } : null;
}

/** 0x005 / 0x006 / 0x007 (push and response): [mapId, start, count, u16 LE x count]. */
export function decodeRegBlock(d) {
  if (d.length < 3) {
    return null;
  }
  const mapId = d[0];
  const start = d[1];
  const count = Math.min(d[2], Math.floor((d.length - 3) / 2));
  const values = [];
  for (let i = 0; i < count; i++) {
    values.push(readU16(d, 3 + 2 * i));
  }
  return { mapId, start, values };
}

/**
 * 0x00D: [mapId, 0, u32 LE]. The push carries 6 bytes; the response (Pack_Read_Historical_Error_
 * Code_Response) declares DataLen = 5, so its last byte (History Error Code4) is cut: null then.
 */
export function decodeHistError(d) {
  if (d.length < 5) {
    return null;
  }
  const bytes = [d[2], d[3], d[4], d.length >= 6 ? d[5] : null];
  const code = bytes[3] == null ? null : readU32(d, 2);
  return { mapId: d[0], code, bytes };
}

/** 0x01A: Send_Temp_Data_To_PC, 6 channels x (int32 uV, int16 temp x10). */
export function decodeTemp(d) {
  const ch = [];
  for (let i = 0; i + 6 <= d.length && i < 36; i += 6) {
    const uV = readS32(d, i);
    const t = readS16(d, i + 4);
    ch.push({ uV, tempX10: t, burnout: t === -1000 });
  }
  return ch;
}

/** 0x01B: Send_Self_V_And_I_To_PC. */
export function decodeSelfVI(d) {
  return d.length >= 4 ? { vX10: readU16(d, 0), iX10: readU16(d, 2) } : null;
}

/** 0x01C (PLATFORM_40V): Send_BMS_Data_To_PC, 25 bytes. Scaling as in Log_Battery_Data (app_battery_communitate.c). */
export function decodeBms40(d) {
  if (d.length < 25) {
    return null;
  }
  const raw = {
    hwPn: readU32(d, 0), hwMajor: d[4], hwMinor: d[5],
    fwPn: readU32(d, 6), fwMajor: d[10], fwMinor: d[11], fwPatch: d[12],
    soc: readU16(d, 13), voltage: readU16(d, 15), current: readU16(d, 17),
    cellTemp: readU16(d, 19), warning: readU16(d, 21), charge: d[23], discharge: d[24],
  };
  return {
    ...raw,
    socPct: raw.soc / 10,
    voltageV: raw.voltage / 10,
    currentA: (raw.current - 20000) / 10,
    cellTempLog: raw.cellTemp - 300,
  };
}

/** 0x01D (PLATFORM_18V): Send_BMS_Data_To_PC. */
export function decodeBat18(d) {
  if (d.length < 14) {
    return null;
  }
  return {
    series: d[0], parallel: d[1], capacityMah: readU16(d, 2),
    fw: `${d[4]}.${d[5]}.${d[6]}`, hw: d[7],
    current: readS16(d, 8), temp: readS16(d, 10), fuelLeds: d[12], mode: d[13],
  };
}

/* ------------------------------------------------------------------ PCBA view */
const hex4 = (v) => (v == null ? null : v.toString(16).toUpperCase().padStart(4, '0'));

/** Engineering values of one PCBA from its register array (null = not received yet). */
export function pcbaView(r) {
  const has = (i) => r[i] != null;
  const pv = r[REG.PTCL_VERSION] ?? 0;
  const pn = has(REG.PN_LOW) && has(REG.PN_HIGH) ? u32(r[REG.PN_HIGH] * 65536 + r[REG.PN_LOW]) : null;
  const v33 = pv >= T_TECH_PV_3P3;
  const fullDuty = r[REG.FULL_DUTY] || 3600;

  const info = {
    pn,
    protocolVersion: has(REG.PTCL_VERSION) ? `${pv >> 8}.${pv & 0xFF}` : null,
    pv,
    fwVersion: has(REG.FW_VERSION) ? `${r[REG.FW_VERSION] >> 8}.${r[REG.FW_VERSION] & 0xFF}` : null,
    fwMode: r[REG.FW_MODE],
    toolsNum: has(REG.PCBA_NUM) ? r[REG.PCBA_NUM] >> 8 : null,
    volType: r[REG.PCBA_VOL],
    fullDuty: r[REG.FULL_DUTY],
    currentOffset: r[REG.CURRENT_OFFSET],
    uid: [REG.UID_5, REG.UID_4, REG.UID_3, REG.UID_2, REG.UID_1, REG.UID_0].every(has)
      ? [REG.UID_5, REG.UID_4, REG.UID_3, REG.UID_2, REG.UID_1, REG.UID_0].map((i) => hex4(r[i])).join('')
      : null,
    fwPn: pv <= T_TECH_PV_3P1 ? pn
      : (has(REG.FW_PN_LOW) && has(REG.FW_PN_HIGH) ? u32(r[REG.FW_PN_HIGH] * 65536 + r[REG.FW_PN_LOW]) : null),
    opGain: v33 ? r[REG.OP_GAIN] : null,
    shunt: v33 ? r[REG.SHUNT] : null,
    volDiv: v33 ? r[REG.VOL_DIV] : null,
    ntcType: v33 ? r[REG.NTC_TYPE] : null,
    ntcDivR: v33 ? r[REG.NTC_DIV_R] : null,
  };

  const run = {};
  if (has(REG.MOTOR_SM)) {
    const sm = r[REG.MOTOR_SM];
    run.smRaw = sm;
    run.sm = MOTOR_SM[sm > 5 ? 0 : sm];
  }
  if (has(REG.ERROR_CODE)) {
    run.errorCode = r[REG.ERROR_CODE];
  }
  if (has(REG.MOTOR_SPEED)) {
    run.rpm = r[REG.MOTOR_SPEED];
  }
  if (has(REG.CURRENT)) {
    run.currentRaw = r[REG.CURRENT];
    run.currentA = adToX10I(r[REG.CURRENT], {
      pv, pn: pn ?? 0, offset: r[REG.CURRENT_OFFSET] ?? 0,
      opGain: r[REG.OP_GAIN] ?? 0, shunt: r[REG.SHUNT] ?? 0,
    }) / 10;
  }
  if (has(REG.VOLTAGE)) {
    run.voltageRaw = r[REG.VOLTAGE];
    run.voltageV = adToX10V(r[REG.VOLTAGE], {
      pv, volType: r[REG.PCBA_VOL] ?? 0, divider: r[REG.VOL_DIV] ?? 0,
    }) / 10;
  }
  if (run.currentA != null && run.voltageV != null) {
    run.powerW = run.currentA * run.voltageV;
  }
  if (has(REG.PCBA_TEMP)) {
    run.tempRaw = r[REG.PCBA_TEMP];
    run.tempC = ntcAdToX10Degree(r[REG.PCBA_TEMP]) / 10;
  }
  if (has(REG.POT)) {
    run.potRaw = r[REG.POT];
    run.potPct = div(r[REG.POT] * 100, 4095);
  }
  if (has(REG.PWM_DUTY)) {
    run.dutyRaw = r[REG.PWM_DUTY];
    run.dutyPct = div(r[REG.PWM_DUTY] * 100, fullDuty);
  }
  if (has(REG.DEBUG_DATA1)) {
    run.debug1 = r[REG.DEBUG_DATA1];
  }
  if (has(REG.DEBUG_DATA2)) {
    run.debug2 = r[REG.DEBUG_DATA2];
  }
  if (has(REG.MOTOR_DIR)) {
    run.dir = r[REG.MOTOR_DIR];
  }

  const gpio = ['A', 'B', 'C', 'D', 'E', 'F'].map((p, i) => ({
    port: p, in: hex4(r[REG.GPIOA_IDR + 2 * i]), out: hex4(r[REG.GPIOA_ODR + 2 * i]),
  }));

  const protect = PROTECTIONS.map((p) => ({
    name: p.name, en: r[p.en], value: r[p.value], time: r[p.time],
  }));
  protect.push({ name: 'JamProtect', en: r[REG.JAM_PROTECT_EN], value: null, time: null });

  return { info, run, gpio, protect };
}

/** target id used on the T-Tech bus for a map id (Calc_PCBA_MapID_To_TgtID). */
export function mapIdToTargetId(mapId) {
  return mapId === 0 ? 0x01 : 0xA0 + mapId;
}
