// Turns a signal the controller received back into a protocol, address and
// command, so a press can be looked up in the fingerprint database.
//
// The timings come from the tables in protocols.ts rather than a second copy,
// and ir-decode.test.ts round-trips every protocol through encodeProtocol, so
// an encoder change cannot silently break decoding.

import { MANCHESTER_PROTOCOLS, PULSE_PROTOCOLS } from './protocols';
import type { manchester_def_t, pulse_def_t } from './protocols';

export type ir_decoded_t = {
  protocol: string;
  address: number;
  command: number;
};

// A receiver measures edges, not intentions: marks come back long and spaces
// short by roughly the detector's response time, and cheap remotes are off by
// more than that again.
const TOLERANCE = 0.3;
const TOLERANCE_FLOOR_US = 120;
const FRAME_GAP_US = 8000;

function near(value: number, expected: number): boolean {
  return (
    Math.abs(value - expected) <=
    Math.max(expected * TOLERANCE, TOLERANCE_FLOOR_US)
  );
}

// A capture can hold more than the message: remotes send repeats, and some
// put a short burst in front of the real frame. Each one is tried in turn
// rather than assuming the first is the one that matters.
export function framesOf(timings: number[]): number[][] {
  const out: number[][] = [];
  let current: number[] = [];

  for (const value of timings) {
    if (value < 0 && Math.abs(value) >= FRAME_GAP_US) {
      if (current.length > 4) {
        out.push(current);
      }

      current = [];
      continue;
    }

    // A frame starts at a mark; a leading space is the gap before it.
    if (current.length > 0 || value > 0) {
      current.push(value);
    }
  }

  if (current.length > 4) {
    out.push(current);
  }

  return out;
}

function bitsToBytes(bits: number[]): number[] {
  const out: number[] = [];

  bits.forEach((bit, i) => {
    out[i >> 3] = (out[i >> 3] ?? 0) | (bit << (i & 7));
  });

  return out;
}

function readPulseBits(def: pulse_def_t, frame: number[]): number[] | null {
  let at = 0;

  if (def.preamble) {
    if (
      frame.length < 2 ||
      !near(frame[0], def.preamble[0]) ||
      !near(-frame[1], def.preamble[1])
    ) {
      return null;
    }
    at = 2;
  }

  // Pulse-distance protocols carry the bit in the space, pulse-width ones in
  // the mark; whichever differs between a one and a zero is the one to read.
  const bySpace = def.one[1] !== def.zero[1];
  const bits: number[] = [];

  while (bits.length < def.bits) {
    const mark = frame[at];
    const space = -frame[at + 1];

    if (mark === undefined || !(mark > 0)) {
      return null;
    }

    // The last bit of a trailerless protocol has no space of its own.
    const measured = bySpace ? space : mark;
    const one = bySpace ? def.one[1] : def.one[0];
    const zero = bySpace ? def.zero[1] : def.zero[0];

    if (measured === undefined || Number.isNaN(measured)) {
      return null;
    }

    // A space is also read with its mark, as the bit's period: what a
    // receiver adds to the mark it takes from the space, so the sum stays (a
    // remote at 680/470 for NEC's 560/560 comes back near 770/400, out of
    // the space's own tolerance but not the period's). Either reading will
    // do; one near both a one and a zero (RCA's periods meet at 30%) is the
    // nearer one by its period
    const period = mark + measured;
    const onePeriod = def.one[0] + def.one[1];
    const zeroPeriod = def.zero[0] + def.zero[1];
    const isOne = near(measured, one) || (bySpace && near(period, onePeriod));
    const isZero =
      near(measured, zero) || (bySpace && near(period, zeroPeriod));

    if (isOne && isZero) {
      const [v, o, z] = bySpace
        ? [period, onePeriod, zeroPeriod]
        : [measured, one, zero];
      bits.push(Math.abs(v - o) < Math.abs(v - z) ? 1 : 0);
    } else if (isOne) {
      bits.push(1);
    } else if (isZero) {
      bits.push(0);
    } else {
      return null;
    }

    at += 2;
  }

  // SIRC comes in 12, 15 and 20 bit forms with identical timings, so a short
  // read of a long frame would pass. The frame has to end where the bits do.
  const left = frame.length - at;

  return bits.length === def.bits && left <= (def.trailer > 0 ? 2 : 1)
    ? bits
    : null;
}

function invert(value: number, mask: number): number {
  return ~value & mask;
}

// The inverse of each table entry's assemble(). A null means the frame decoded
// cleanly but failed the protocol's own integrity check, which is how NEC is
// told apart from NECext - they share every timing.
const DISASSEMBLE: Record<
  string,
  (bytes: number[]) => { address: number; command: number } | null
> = {
  NEC: b =>
    b[1] === invert(b[0], 0xff) && b[3] === invert(b[2], 0xff)
      ? { address: b[0], command: b[2] }
      : null,
  NECext: b => ({ address: b[0] | (b[1] << 8), command: b[2] | (b[3] << 8) }),
  NEC42: b => {
    const low = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    const high = b[4] | (b[5] << 8);
    const address = low & 0x1fff;
    const command = ((low >>> 26) & 0x3f) | ((high & 0x3) << 6);

    return invert(address, 0x1fff) === ((low >>> 13) & 0x1fff) &&
      invert(command, 0xff) === ((high >>> 2) & 0xff)
      ? { address, command }
      : null;
  },
  NEC42ext: b => {
    const low = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    const high = b[4] | (b[5] << 8);

    return {
      address: low & 0x3ffffff,
      command: ((low >>> 26) & 0x3f) | ((high & 0x3ff) << 6),
    };
  },
  Samsung32: b =>
    b[0] === b[1] && b[3] === invert(b[2], 0xff)
      ? { address: b[0], command: b[2] }
      : null,
  SIRC: b => sirc(b, 0x1f),
  SIRC15: b => sirc(b, 0xff),
  SIRC20: b => sirc(b, 0x1fff),
  RCA: b => {
    const value = (b[0] | (b[1] << 8) | (b[2] << 16)) >>> 0;
    const address = value & 0xf;
    const command = (value >>> 4) & 0xff;

    return invert(address, 0xf) === ((value >>> 12) & 0xf) &&
      invert(command, 0xff) === ((value >>> 16) & 0xff)
      ? { address, command }
      : null;
  },
  Kaseikyo: b => {
    if (b[5] !== (b[2] ^ b[3] ^ b[4])) {
      return null;
    }

    const vendor = b[0] | (b[1] << 8);

    return {
      address:
        ((((b[4] >> 6) & 3) << 24) |
          (vendor << 8) |
          ((b[2] >> 4) << 4) |
          (b[3] & 0xf)) >>>
        0,
      command: ((b[4] & 0x3f) << 4) | (b[3] >> 4),
    };
  },
};

function sirc(
  bytes: number[],
  addressMask: number
): { address: number; command: number } {
  const value =
    (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;

  return { address: (value >>> 7) & addressMask, command: value & 0x7f };
}

// Half-bit levels, so a Manchester frame can be read as transitions rather
// than as durations.
function levels(def: manchester_def_t, frame: number[]): boolean[] | null {
  const out: boolean[] = [];
  let at = 0;

  if (def.preamble) {
    if (
      frame.length < 2 ||
      !near(frame[0], def.preamble[0]) ||
      !near(-frame[1], def.preamble[1])
    ) {
      return null;
    }
    at = 2;
  }

  // RC5 opens on a start bit, whose low half is just silence: a receiver
  // starts recording at the first mark and never reports it, so it is put
  // back here or every bit after it reads one half out of step.
  if (!def.preamble && frame[at] > 0) {
    out.push(false);
  }

  for (let i = at; i < frame.length; i++) {
    const count = Math.round(Math.abs(frame[i]) / def.half);

    if (count < 1 || count > 4 || !near(Math.abs(frame[i]), count * def.half)) {
      return null;
    }

    for (let n = 0; n < count; n++) {
      out.push(frame[i] > 0);
    }
  }

  return out;
}

function readManchesterBits(
  def: manchester_def_t,
  frame: number[]
): number[] | null {
  const halves = levels(def, frame);

  if (!halves) {
    return null;
  }

  const bits: number[] = [];
  let at = 0;

  while (bits.length < def.bits) {
    // RC6's toggle bit is twice as wide as every other bit.
    const width = bits.length === def.doubleAt ? 2 : 1;
    const first = halves[at];
    const second = halves[at + width];

    if (first === undefined || second === undefined || first === second) {
      // A trailing space the receiver never saw still leaves the bit readable.
      if (
        first !== undefined &&
        second === undefined &&
        bits.length === def.bits - 1
      ) {
        bits.push(first === def.risingIsOne ? 0 : 1);
        break;
      }
      return null;
    }

    bits.push(second === def.risingIsOne ? 1 : 0);
    at += width * 2;
  }

  return bits.length === def.bits ? bits : null;
}

function fromRc5(bits: number[]): { address: number; command: number } {
  let address = 0;
  let command = bits[1] ? 0 : 0x40;

  for (let i = 0; i < 5; i++) {
    address = (address << 1) | bits[3 + i];
  }
  for (let i = 0; i < 6; i++) {
    command |= bits[8 + i] << (5 - i);
  }

  return { address, command };
}

function reverseByte(value: number): number {
  let out = 0;

  for (let i = 0; i < 8; i++) {
    out = (out << 1) | ((value >> i) & 1);
  }

  return out & 0xff;
}

function fromRc6(bits: number[]): { address: number; command: number } {
  let address = 0;
  let command = 0;

  for (let i = 0; i < 8; i++) {
    address = (address << 1) | bits[5 + i];
    command = (command << 1) | bits[13 + i];
  }

  return { address: reverseByte(address), command: reverseByte(command) };
}

// One waveform can have more than one honest reading: an NECext frame whose
// address happens to be a byte and its complement is also a valid NEC frame,
// and RC5 and RC5X are the same frame under two names. Both readings are
// returned so a lookup can try each, rather than guessing one and missing.
export function decodeAll(timings: number[]): ir_decoded_t[] {
  for (const frame of framesOf(timings)) {
    const readings = decodeFrame(frame);

    if (readings.length > 0) {
      return readings;
    }
  }

  return [];
}

function decodeFrame(frame: number[]): ir_decoded_t[] {
  const out: ir_decoded_t[] = [];

  if (frame.length < 6) {
    return out;
  }

  for (const [protocol, def] of Object.entries(PULSE_PROTOCOLS)) {
    const bits = readPulseBits(def, frame);
    const parts = bits && DISASSEMBLE[protocol]?.(bitsToBytes(bits));

    if (parts) {
      out.push({ protocol, ...parts });
    }
  }

  for (const [protocol, def] of Object.entries(MANCHESTER_PROTOCOLS)) {
    const bits = readManchesterBits(def, frame);

    if (!bits) {
      continue;
    }

    if (protocol === 'RC6') {
      out.push({ protocol, ...fromRc6(bits) });
    } else if (!out.some(found => found.protocol === protocol)) {
      // RC5 and RC5X share a table entry, so the pair is emitted once.
      const parts = fromRc5(bits);

      out.push({ protocol: 'RC5', ...parts }, { protocol: 'RC5X', ...parts });
    }
  }

  return out;
}

export function decodeSignal(timings: number[]): ir_decoded_t | null {
  return decodeAll(timings)[0] ?? null;
}
