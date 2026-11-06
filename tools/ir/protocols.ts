import { DEFAULT_FREQ } from './types';
import type { ir_signal_t } from './types';

// Timings and bit layouts mirror the Flipper firmware encoders in
// lib/infrared/encoder_decoder, because the Flipper-IRDB files this feeds on
// are produced by that implementation.

export type pulse_def_t = {
  freq: number;
  preamble: [number, number] | null;
  one: [number, number];
  zero: [number, number];
  trailer: number;
  bits: number;
  // A real remote never sends a single frame, and neither do the captured
  // codes that work elsewhere: every Broadlink code in SmartIR decodes to
  // 2-14 frames, and codes learned by the device itself hold 3-6. Synthesising
  // one frame is why protocol-encoded imports were ignored by appliances.
  // Periods are Flipper's REPEAT_PERIOD / REPEAT_PAUSE constants.
  frames?: number;
  periodUs?: number;
  // NEC repeats with a short "ditto" burst rather than a second full frame;
  // resending the whole frame reads as a second key press on some devices.
  ditto?: number[];
  dittoGaps?: [number, number];
  assemble: (address: number, command: number) => number[];
};

function reverseByte(value: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    out = (out << 1) | ((value >> i) & 1);
  }
  return out & 0xff;
}

function bytesToBits(bytes: number[], bits: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits; i++) {
    out.push((bytes[i >> 3] >> (i & 7)) & 1);
  }
  return out;
}

export const PULSE_PROTOCOLS: Record<string, pulse_def_t> = {
  NEC: {
    freq: DEFAULT_FREQ,
    preamble: [9000, 4500],
    one: [560, 1690],
    zero: [560, 560],
    trailer: 560,
    bits: 32,
    frames: 2,
    periodUs: 110000,
    ditto: [9000, -2250, 560],
    dittoGaps: [41000, 96000],
    assemble: (a, c) => [a & 0xff, ~a & 0xff, c & 0xff, ~c & 0xff],
  },
  NECext: {
    freq: DEFAULT_FREQ,
    preamble: [9000, 4500],
    one: [560, 1690],
    zero: [560, 560],
    trailer: 560,
    bits: 32,
    frames: 2,
    periodUs: 110000,
    ditto: [9000, -2250, 560],
    dittoGaps: [41000, 96000],
    assemble: (a, c) => [a & 0xff, (a >> 8) & 0xff, c & 0xff, (c >> 8) & 0xff],
  },
  NEC42: {
    freq: DEFAULT_FREQ,
    preamble: [9000, 4500],
    one: [560, 1690],
    zero: [560, 560],
    trailer: 560,
    bits: 42,
    frames: 2,
    periodUs: 110000,
    ditto: [9000, -2250, 560],
    dittoGaps: [41000, 96000],
    assemble: (a, c) =>
      nec42Bytes(
        ((a & 0x1fff) | ((~a & 0x1fff) << 13) | ((c & 0x3f) << 26)) >>> 0,
        (((c & 0xc0) >> 6) | ((~c & 0xff) << 2)) >>> 0
      ),
  },
  NEC42ext: {
    freq: DEFAULT_FREQ,
    preamble: [9000, 4500],
    one: [560, 1690],
    zero: [560, 560],
    trailer: 560,
    bits: 42,
    frames: 2,
    periodUs: 110000,
    ditto: [9000, -2250, 560],
    dittoGaps: [41000, 96000],
    assemble: (a, c) =>
      nec42Bytes(
        ((a & 0x3ffffff) | ((c & 0x3f) << 26)) >>> 0,
        ((c & 0xffc0) >> 6) >>> 0
      ),
  },
  Samsung32: {
    freq: DEFAULT_FREQ,
    preamble: [4500, 4500],
    one: [550, 1650],
    zero: [550, 550],
    trailer: 550,
    bits: 32,
    frames: 2,
    periodUs: 108000,
    assemble: (a, c) => [a & 0xff, a & 0xff, c & 0xff, ~c & 0xff],
  },
  SIRC: {
    freq: 40000,
    preamble: [2400, 600],
    one: [1200, 600],
    zero: [600, 600],
    trailer: 0,
    bits: 12,
    frames: 3,
    periodUs: 45000,
    assemble: (a, c) => sircBytes(c & 0x7f, a & 0x1f),
  },
  SIRC15: {
    freq: 40000,
    preamble: [2400, 600],
    one: [1200, 600],
    zero: [600, 600],
    trailer: 0,
    bits: 15,
    frames: 3,
    periodUs: 45000,
    assemble: (a, c) => sircBytes(c & 0x7f, a & 0xff),
  },
  SIRC20: {
    freq: 40000,
    preamble: [2400, 600],
    one: [1200, 600],
    zero: [600, 600],
    trailer: 0,
    bits: 20,
    frames: 3,
    periodUs: 45000,
    assemble: (a, c) => sircBytes(c & 0x7f, a & 0x1fff),
  },
  RCA: {
    freq: 56000,
    preamble: [4000, 4000],
    one: [500, 2000],
    zero: [500, 1000],
    trailer: 500,
    bits: 24,
    frames: 2,
    periodUs: 8000,
    assemble: (a, c) => {
      const value =
        (a & 0xf) |
        ((c & 0xff) << 4) |
        ((~a & 0xf) << 12) |
        ((~c & 0xff) << 16);
      return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
    },
  },
  Kaseikyo: {
    freq: 37000,
    preamble: [3456, 1728],
    one: [432, 1296],
    zero: [432, 432],
    trailer: 432,
    bits: 48,
    frames: 2,
    periodUs: 130000,
    assemble: (a, c) => {
      const id = (a >>> 24) & 3;
      const vendor = (a >>> 8) & 0xffff;
      const genre1 = (a >>> 4) & 0xf;
      const genre2 = a & 0xf;

      const d0 = vendor & 0xff;
      const d1 = (vendor >> 8) & 0xff;
      let parity = d0 ^ d1;
      parity = (parity & 0xf) ^ (parity >> 4);

      const d2 = (parity & 0xf) | (genre1 << 4);
      const d3 = (genre2 & 0xf) | ((c & 0xf) << 4);
      const d4 = (id << 6) | ((c >> 4) & 0x3f);
      const d5 = d2 ^ d3 ^ d4;

      return [d0, d1, d2, d3, d4, d5];
    },
  },
};

function nec42Bytes(low: number, high: number): number[] {
  return [
    low & 0xff,
    (low >>> 8) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 24) & 0xff,
    high & 0xff,
    (high >>> 8) & 0xff,
  ];
}

function sircBytes(command: number, address: number): number[] {
  const value = (command | (address << 7)) >>> 0;
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

const MIN_FRAME_GAP_US = 10000;

function encodePulse(
  def: pulse_def_t,
  address: number,
  command: number
): ir_signal_t {
  const bits = bytesToBits(def.assemble(address, command), def.bits);
  const frame: number[] = [];

  if (def.preamble) {
    frame.push(def.preamble[0], -def.preamble[1]);
  }

  for (const bit of bits) {
    const [mark, space] = bit ? def.one : def.zero;
    frame.push(mark, -space);
  }

  if (def.trailer > 0) {
    frame.push(def.trailer);
  }

  return {
    timings: repeatFrame(
      frame,
      def.frames ?? 1,
      def.periodUs ?? 0,
      def.ditto,
      def.dittoGaps
    ),
    freq: def.freq,
  };
}

function repeatFrame(
  frame: number[],
  frames: number,
  periodUs: number,
  ditto?: number[],
  dittoGaps?: [number, number]
): number[] {
  if (frames < 2) {
    return frame;
  }

  const out = [...frame];

  if (ditto && dittoGaps) {
    for (let i = 1; i < frames; i++) {
      out.push(-(i === 1 ? dittoGaps[0] : dittoGaps[1]), ...ditto);
    }

    return out;
  }

  const duration = frame.reduce((sum, value) => sum + Math.abs(value), 0);
  const gap = Math.max(MIN_FRAME_GAP_US, periodUs - duration);

  for (let i = 1; i < frames; i++) {
    out.push(-gap, ...frame);
  }

  return out;
}

export type manchester_def_t = {
  freq: number;
  half: number;
  preamble: [number, number] | null;
  bits: number;
  doubleAt: number;
  frames: number;
  periodUs: number;
  // RC5 encodes a 1 as a low-to-high transition, RC6 as high-to-low.
  risingIsOne: boolean;
  assemble: (address: number, command: number) => number[];
};

export const MANCHESTER_PROTOCOLS: Record<string, manchester_def_t> = {
  RC5: {
    freq: 36000,
    half: 889,
    preamble: null,
    bits: 14,
    doubleAt: -1,
    frames: 2,
    periodUs: 114000,
    risingIsOne: true,
    assemble: rc5Bits,
  },
  RC5X: {
    freq: 36000,
    half: 889,
    preamble: null,
    bits: 14,
    doubleAt: -1,
    frames: 2,
    periodUs: 114000,
    risingIsOne: true,
    assemble: rc5Bits,
  },
  RC6: {
    freq: 36000,
    half: 444,
    preamble: [2666, 889],
    bits: 21,
    doubleAt: 4,
    frames: 2,
    periodUs: 114000,
    risingIsOne: false,
    assemble: (a, c) => {
      const bits: number[] = [1, 0, 0, 0, 0];
      const addr = reverseByte(a & 0xff);
      const cmd = reverseByte(c & 0xff);
      for (let i = 0; i < 8; i++) {
        bits.push((addr >> (7 - i)) & 1);
      }
      for (let i = 0; i < 8; i++) {
        bits.push((cmd >> (7 - i)) & 1);
      }
      return bits;
    },
  },
};

// The second start bit carries the inverted bit 6 of the command, which is 1
// for every command below 64 — so one rule covers both RC5 and RC5X.
// The toggle bit is per-press state the device never sees change, because a
// stored code is re-emitted verbatim.
function rc5Bits(address: number, command: number): number[] {
  const bits: number[] = [1, (~command >> 6) & 1, 0];

  for (let i = 4; i >= 0; i--) {
    bits.push((address >> i) & 1);
  }
  for (let i = 5; i >= 0; i--) {
    bits.push((command >> i) & 1);
  }

  return bits;
}

function encodeManchester(
  def: manchester_def_t,
  address: number,
  command: number
): ir_signal_t {
  const bits = def.assemble(address, command);
  const levels: Array<[boolean, number]> = [];

  if (def.preamble) {
    levels.push([true, def.preamble[0]], [false, def.preamble[1]]);
  }

  bits.forEach((bit, index) => {
    const unit = index === def.doubleAt ? def.half * 2 : def.half;
    const rising = bit ? def.risingIsOne : !def.risingIsOne;
    if (rising) {
      levels.push([false, unit], [true, unit]);
    } else {
      levels.push([true, unit], [false, unit]);
    }
  });

  const frame: number[] = [];
  let current: boolean | null = null;
  let run = 0;

  for (const [level, duration] of levels) {
    if (level === current) {
      run += duration;
      continue;
    }
    if (current !== null) {
      frame.push(current ? run : -run);
    }
    current = level;
    run = duration;
  }

  if (current !== null) {
    frame.push(current ? run : -run);
  }

  return {
    timings: repeatFrame(frame, def.frames, def.periodUs),
    freq: def.freq,
  };
}

export function isProtocolSupported(protocol: string): boolean {
  return protocol in PULSE_PROTOCOLS || protocol in MANCHESTER_PROTOCOLS;
}

export function encodeProtocol(
  protocol: string,
  address: number,
  command: number
): ir_signal_t {
  const pulse = PULSE_PROTOCOLS[protocol];
  if (pulse) {
    return encodePulse(pulse, address, command);
  }

  const manchester = MANCHESTER_PROTOCOLS[protocol];
  if (manchester) {
    return encodeManchester(manchester, address, command);
  }

  throw new Error(`Unsupported protocol "${protocol}"`);
}
