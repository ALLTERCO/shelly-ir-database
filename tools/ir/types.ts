import {
  IR_DEFAULT_FREQ,
  IR_MAX_FREQ,
  IR_MAX_TIMINGS,
  IR_MIN_FREQ,
  RPC_MAX_PAYLOAD,
} from './limits';

export const DEFAULT_FREQ = IR_DEFAULT_FREQ;
export const MIN_FREQ = IR_MIN_FREQ;
export const MAX_FREQ = IR_MAX_FREQ;
export const MAX_TIMINGS = IR_MAX_TIMINGS;

// the frame must stay under SHOS_RPC_MAX_PAYLOAD (checked as len >= max);
// room is kept for the auth the transport adds once the device asks for a
// password, and a margin for what the estimate can't know
export const MAX_FRAME_BYTES = RPC_MAX_PAYLOAD - 1;
export const AUTH_RESERVE_BYTES = 224;
export const SAFE_FRAME_BYTES = MAX_FRAME_BYTES - AUTH_RESERVE_BYTES - 200;

// UsToTicks truncates: ticks = |us| / 10, clamped to the 15-bit field.
export const TICK_US = 10;
export const MAX_DURATION_US = 0x7fff * TICK_US;

export type ir_source_format_t =
  'flipper' | 'lirc-conf' | 'lirc-xml' | 'girr' | 'smartir' | 'wigshop';

export type ir_signal_format_t = 'raw' | 'pronto' | 'broadlink';

export type ir_skip_reason_t =
  | 'unsupported-protocol'
  | 'unsupported-pronto'
  | 'unsupported-encoding'
  | 'bad-data'
  | 'empty'
  | 'too-long'
  | 'duplicate';

export type ir_record_t = {
  id: string;
  name: string;
  rawName: string;
  timings: number[];
  freq: number;
  bytes: number;
  group?: string;
  protocol?: string;
  skipReason?: ir_skip_reason_t;
  skipDetail?: string;
  warnings?: string[];
  // the button it drives, as the file says (a Shelly export's function)
  function?: string;
};

export type ir_remote_t = {
  name: string;
  manufacturer?: string;
  models?: string[];
  // its layout, as the file says (a Shelly export's type)
  type?: string;
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
