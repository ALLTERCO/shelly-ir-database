import { clampFreq, DEFAULT_FREQ } from './types';
import type { ir_record_t, ir_skip_reason_t } from './types';
import { checkStoreCode, normaliseTimings } from './timings';

export type record_input_t = {
  id: string;
  name: string;
  timings?: number[];
  freq?: number;
  group?: string;
  protocol?: string;
  warnings?: string[];
  skipReason?: ir_skip_reason_t;
  skipDetail?: string;
};

// The firmware stores exactly what it is sent, and a learned code on the device
// keeps every frame the remote transmitted (a learned Sony code holds six
// frames at a 45 ms period). Protocols like Sony are ignored unless the frame
// repeats, so the frames a source provides are kept verbatim.
export function buildRecord(input: record_input_t): ir_record_t {
  const rawName = input.name;
  const name = normaliseCodeName(rawName);
  const freq = clampFreq(input.freq ?? DEFAULT_FREQ);

  if (input.skipReason) {
    return {
      id: input.id,
      name,
      rawName,
      timings: [],
      freq,
      group: input.group,
      protocol: input.protocol,
      warnings: input.warnings,
      skipReason: input.skipReason,
      skipDetail: input.skipDetail,
    };
  }

  const timings = normaliseTimings(input.timings ?? []);

  const failure = checkStoreCode(name, timings);

  return {
    id: input.id,
    name,
    rawName,
    timings,
    freq,
    group: input.group,
    protocol: input.protocol,
    warnings: input.warnings,
    skipReason: failure?.reason,
    skipDetail: failure?.detail,
  };
}

export function normaliseCodeName(raw: string): string {
  return raw
    .trim()
    .replace(/^KEY_/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_');
}
