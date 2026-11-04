import { MAX_DURATION_US, TICK_US } from './types';
import type { ir_skip_reason_t } from './types';

// A space this long can only be an inter-frame gap, never a bit.
const MIN_FRAME_GAP_US = 8000;
const FRAME_GAP_FACTOR = 4;

export function quantise(us: number): number {
  const abs = Math.min(Math.abs(us), MAX_DURATION_US);
  const ticks = Math.max(1, Math.round(abs / TICK_US));

  return (us < 0 ? -1 : 1) * ticks * TICK_US;
}

export function normaliseTimings(timings: number[]): number[] {
  const merged: number[] = [];

  for (const value of timings) {
    if (!Number.isFinite(value) || value === 0) {
      continue;
    }

    const last = merged.length - 1;
    if (merged.length > 0 && (merged[last] < 0) === (value < 0)) {
      merged[last] += value;
      continue;
    }

    merged.push(value);
  }

  // A code has to start with a mark; a leading space is a source artefact.
  while (merged.length > 0 && merged[0] < 0) {
    merged.shift();
  }

  // The gap after the last mark is produced by the emit timer, not by the
  // stored symbols, so carrying it would only waste frame bytes.
  while (merged.length > 0 && merged[merged.length - 1] < 0) {
    merged.pop();
  }

  return merged.map(quantise);
}

export function splitFrames(timings: number[]): number[][] {
  if (timings.length === 0) {
    return [];
  }

  let headerSpace = 0;
  for (let i = 0; i < Math.min(4, timings.length); i++) {
    if (timings[i] < 0) {
      headerSpace = Math.max(headerSpace, -timings[i]);
    }
  }

  const threshold = Math.max(MIN_FRAME_GAP_US, headerSpace * FRAME_GAP_FACTOR);
  const frames: number[][] = [];
  let current: number[] = [];

  for (const value of timings) {
    if (value < 0 && -value >= threshold && current.length > 0) {
      frames.push(current);
      current = [];
      continue;
    }

    current.push(value);
  }

  if (current.length > 0) {
    frames.push(current);
  }

  return frames;
}

export function firstFrame(timings: number[]): number[] {
  const frames = splitFrames(timings);

  return frames.length > 0 ? frames[0] : timings;
}

export function checkStoreCode(
  name: string,
  timings: number[]
): { reason: ir_skip_reason_t; detail: string } | null {
  if (timings.length === 0) {
    return { reason: 'empty', detail: 'decoded to no timings' };
  }

  if (name.length === 0) {
    return { reason: 'bad-data', detail: 'has no usable name' };
  }

  return null;
}

export function totalDurationUs(timings: number[]): number {
  return timings.reduce((sum, value) => sum + Math.abs(value), 0);
}
