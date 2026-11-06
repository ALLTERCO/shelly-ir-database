import { DEFAULT_FREQ } from './types';
import type { ir_signal_t } from './types';

const TYPE_IR = 0x26;
const TICK_US = 269000 / 8192;
const TERMINATOR = [0x0d, 0x05];

function decodeBase64(b64: string): number[] {
  const clean = b64.trim().replace(/\s+/g, '');
  let binary: string;

  try {
    binary = atob(clean);
  } catch {
    throw new Error('Not valid base64');
  }

  const bytes: number[] = [];
  for (let i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i) & 0xff);
  }

  return bytes;
}

export function broadlinkToTimings(b64: string): ir_signal_t {
  const bytes = decodeBase64(b64);

  if (bytes.length < 5) {
    throw new Error('Broadlink packet is too short');
  }

  if (bytes[0] !== TYPE_IR) {
    throw new Error(
      `Not an IR Broadlink packet (type 0x${bytes[0].toString(16)}) — RF codes cannot be emitted`
    );
  }

  const length = bytes[2] | (bytes[3] << 8);
  let end = Math.min(bytes.length, 4 + length);

  // The 0x0d 0x05 terminator is counted in the length, and 0x0d is a plausible
  // tick value, so it is trimmed here rather than detected mid-stream.
  if (
    end >= 6 &&
    bytes[end - 2] === TERMINATOR[0] &&
    bytes[end - 1] === TERMINATOR[1]
  ) {
    end -= 2;
  }
  const timings: number[] = [];
  let i = 4;
  let mark = true;

  while (i < end) {
    let ticks = bytes[i];

    if (ticks === 0) {
      if (i + 2 >= end) {
        break;
      }
      ticks = (bytes[i + 1] << 8) | bytes[i + 2];
      i += 3;
    } else {
      i += 1;
    }

    const duration = Math.round(ticks * TICK_US);
    timings.push(mark ? duration : -duration);
    mark = !mark;
  }

  if (timings.length === 0) {
    throw new Error('Broadlink packet carries no timings');
  }

  return { timings, freq: DEFAULT_FREQ };
}

export function timingsToBroadlink(timings: number[]): string {
  if (timings.length === 0) {
    throw new Error('No timings to convert');
  }

  const bytes: number[] = [TYPE_IR, 0x00, 0, 0];

  for (const value of timings) {
    const ticks = Math.max(1, Math.round(Math.abs(value) / TICK_US));

    if (ticks > 0xff) {
      bytes.push(0x00, (ticks >> 8) & 0xff, ticks & 0xff);
    } else {
      bytes.push(ticks);
    }
  }

  bytes.push(...TERMINATOR);

  const length = bytes.length - 4;
  bytes[2] = length & 0xff;
  bytes[3] = (length >> 8) & 0xff;

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
