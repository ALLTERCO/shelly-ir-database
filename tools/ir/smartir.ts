import { DEFAULT_FREQ, IrParseError } from './types';
import type { ir_parse_result_t, ir_record_t, ir_signal_t } from './types';
import { buildRecord } from './record';
import { broadlinkToTimings } from './broadlink';
import { prontoToTimings } from './pronto';

const PACKET_GAP_US = 25000;

type smartir_t = {
  manufacturer?: string;
  supportedModels?: string[];
  supportedController?: string;
  commandsEncoding?: string;
  // a climate file's (an air conditioner)
  operationModes?: unknown;
  commands?: unknown;
};

function decodeRaw(text: string): ir_signal_t {
  // ESPHome's files keep each code as a list in a string: "[3341, -1601, …]"
  const values = text
    .replace(/[[\]]/g, ' ')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);

  if (values.length === 0 || values.some(v => !Number.isFinite(v))) {
    throw new Error('raw data is malformed');
  }

  return {
    timings: values.map((v, i) => (i % 2 === 0 ? Math.abs(v) : -Math.abs(v))),
    freq: DEFAULT_FREQ,
  };
}

function decoderFor(encoding: string): (value: string) => ir_signal_t {
  const key = encoding.toLowerCase();

  if (key === 'base64') {
    return broadlinkToTimings;
  }
  if (key === 'pronto') {
    return prontoToTimings;
  }
  if (key === 'raw') {
    return decodeRaw;
  }

  throw new IrParseError(`Unsupported SmartIR encoding "${encoding}"`);
}

function walk(
  node: unknown,
  path: string[],
  decode: (value: string) => ir_signal_t,
  records: ir_record_t[]
): void {
  if (node === null || node === undefined) {
    return;
  }

  if (typeof node === 'string' || Array.isArray(node)) {
    const id = `smartir-${records.length}`;
    const name = path.join('_');
    const group = path.length > 1 ? path.slice(0, -1).join(' / ') : undefined;
    const parts = Array.isArray(node) ? node : [node];

    if (parts.some(part => typeof part !== 'string')) {
      records.push(
        buildRecord({
          id,
          name,
          group,
          skipReason: 'bad-data',
          skipDetail: 'command is not a code string',
        })
      );
      return;
    }

    try {
      const timings: number[] = [];
      let freq = DEFAULT_FREQ;

      (parts as string[]).forEach((part, index) => {
        const signal = decode(part);
        freq = signal.freq;
        if (index > 0) {
          timings.push(-PACKET_GAP_US);
        }
        timings.push(...signal.timings);
      });

      records.push(
        buildRecord({
          id,
          name,
          group,
          protocol: 'smartir',
          timings,
          freq,
          warnings:
            parts.length > 1
              ? [`sent as ${parts.length} packets in one press`]
              : undefined,
        })
      );
    } catch (error) {
      records.push(
        buildRecord({
          id,
          name,
          group,
          skipReason: 'bad-data',
          skipDetail: String((error as Error).message ?? error),
        })
      );
    }

    return;
  }

  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>
    )) {
      walk(value, [...path, key], decode, records);
    }
  }
}

export function parseSmartIr(text: string): ir_parse_result_t {
  let data: smartir_t;

  try {
    data = JSON.parse(text) as smartir_t;
  } catch {
    throw new IrParseError('Not valid JSON');
  }

  if (!data || typeof data.commands !== 'object' || data.commands === null) {
    throw new IrParseError('Not a SmartIR device file');
  }

  const decode = decoderFor(data.commandsEncoding ?? 'Base64');
  const records: ir_record_t[] = [];
  walk(data.commands, [], decode, records);

  return {
    format: 'smartir',
    remotes: [
      {
        // the brand once: "AUX FREEDOM AUX-09FH", not "AUX AUX FREEDOM…"
        name:
          (data.supportedModels?.[0] &&
          data.manufacturer &&
          data.supportedModels[0]
            .toLowerCase()
            .startsWith(data.manufacturer.toLowerCase())
            ? data.supportedModels[0]
            : [data.manufacturer, data.supportedModels?.[0]]
                .filter(Boolean)
                .join(' ')) || 'SmartIR device',
        manufacturer: data.manufacturer,
        models: data.supportedModels,
        // SmartIR's climate files say their modes; its fan and media files
        // don't
        type: Array.isArray(data.operationModes) ? 'ac' : undefined,
        records,
        warnings: [],
      },
    ],
  };
}
