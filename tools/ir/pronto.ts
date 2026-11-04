import { clampFreq, DEFAULT_FREQ } from './types';
import type { ir_signal_t } from './types';

const PRONTO_CLOCK_US = 0.241246;
const FORMAT_LEARNED = 0x0000;

function parseWords(hex: string): number[] {
  const tokens = hex.trim().split(/[\s,]+/).filter(Boolean);
  const words: number[] = [];

  for (const token of tokens) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(token)) {
      throw new Error(`Not valid Pronto hex: "${token}"`);
    }

    words.push(parseInt(token, 16));
  }

  return words;
}

export function prontoToTimings(hex: string): ir_signal_t {
  const words = parseWords(hex);

  if (words.length < 4) {
    throw new Error('Pronto code is too short');
  }

  if (words[0] !== FORMAT_LEARNED) {
    throw new Error(
      `Unsupported Pronto format 0x${words[0].toString(16).padStart(4, '0')} — only learned codes (0000) are supported`
    );
  }

  const freq = words[1] > 0
    ? clampFreq(1000000 / (words[1] * PRONTO_CLOCK_US))
    : DEFAULT_FREQ;

  const introPairs = words[2];
  const repeatPairs = words[3];
  const body = words.slice(4);

  if (body.length < 2 * (introPairs + repeatPairs)) {
    throw new Error('Pronto code is truncated');
  }

  // The device stores only the first frame, so prefer the intro sequence and
  // fall back to the repeat sequence for codes that carry no intro.
  const take = introPairs > 0
    ? body.slice(0, 2 * introPairs)
    : body.slice(0, 2 * repeatPairs);

  if (take.length === 0) {
    throw new Error('Pronto code carries no bursts');
  }

  const periodUs = 1000000 / freq;
  const timings = take.map((cycles, i) => {
    const duration = Math.round(cycles * periodUs);
    return i % 2 === 0 ? duration : -duration;
  });

  return { timings, freq };
}

const PRONTO_TRAILING_GAP_US = 25000;

// Pronto counts in carrier cycles, so the carrier word is derived first and the
// period recomputed from it — otherwise encoding and decoding disagree by the
// rounding of the carrier itself.
export function timingsToPronto(timings: number[], freq: number): string {
  if (timings.length === 0) {
    throw new Error('No timings to convert');
  }

  const carrier = Math.max(
    1,
    Math.round(1000000 / (clampFreq(freq) * PRONTO_CLOCK_US))
  );
  const periodUs = carrier * PRONTO_CLOCK_US;

  // Pronto is a list of burst pairs, and a signal always ends on a mark, so a
  // closing gap is added to complete the last pair.
  const padded = [...timings];
  if (padded.length % 2 === 1) {
    padded.push(-PRONTO_TRAILING_GAP_US);
  }

  const words = [0, carrier, padded.length / 2, 0].concat(
    padded.map(value => Math.max(1, Math.round(Math.abs(value) / periodUs)))
  );

  return words
    .map(word => word.toString(16).padStart(4, '0').toUpperCase())
    .join(' ');
}
