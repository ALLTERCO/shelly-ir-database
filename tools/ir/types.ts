export const DEFAULT_FREQ = 38000;
export const MIN_FREQ = 20000;
export const MAX_FREQ = 60000;

// UsToTicks truncates: ticks = |us| / 10, clamped to the 15-bit field.
export const TICK_US = 10;
export const MAX_DURATION_US = 0x7fff * TICK_US;


export type ir_source_format_t =
  | 'flipper'
  | 'lirc-conf'
  | 'lirc-xml'
  | 'girr'
  | 'smartir'
  | 'wigshop';

export type ir_signal_format_t = 'raw' | 'pronto' | 'broadlink';

export type ir_skip_reason_t =
  | 'unsupported-protocol'
  | 'unsupported-pronto'
  | 'unsupported-encoding'
  | 'bad-data'
  | 'empty'
  | 'duplicate';

export type ir_record_t = {
  id: string;
  name: string;
  rawName: string;
  timings: number[];
  freq: number;
  group?: string;
  protocol?: string;
  skipReason?: ir_skip_reason_t;
  skipDetail?: string;
  warnings?: string[];
};

export type ir_remote_t = {
  name: string;
  manufacturer?: string;
  models?: string[];
  records: ir_record_t[];
  warnings: string[];
};

export type ir_parse_result_t = {
  format: ir_source_format_t;
  remotes: ir_remote_t[];
};

export type ir_signal_t = {
  timings: number[];
  freq: number;
};

export class IrParseError extends Error {}

export function clampFreq(freq: number): number {
  if (!Number.isFinite(freq)) {
    return DEFAULT_FREQ;
  }

  return Math.min(MAX_FREQ, Math.max(MIN_FREQ, Math.round(freq)));
}
