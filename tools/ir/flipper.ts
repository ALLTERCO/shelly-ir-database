import { DEFAULT_FREQ, IrParseError } from './types';
import type { ir_parse_result_t, ir_record_t } from './types';
import { buildRecord } from './record';
import { encodeProtocol, isProtocolSupported } from './protocols';

function parseHexBytesLE(raw: string): number {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  let value = 0;

  for (let i = 0; i < parts.length && i < 4; i++) {
    const byte = parseInt(parts[i], 16);
    if (!Number.isFinite(byte)) {
      throw new Error(`bad hex byte "${parts[i]}"`);
    }
    value |= (byte & 0xff) << (8 * i);
  }

  return value >>> 0;
}

function recordFromBlock(
  block: Record<string, string>,
  index: number
): ir_record_t {
  const id = `flipper-${index}`;
  const name = block.name ?? '';
  const type = block.type ?? '';

  if (type === 'raw') {
    const values = (block.data ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);

    if (values.length === 0 || values.some(v => !Number.isFinite(v))) {
      return buildRecord({
        id,
        name,
        skipReason: 'bad-data',
        skipDetail: 'raw data is missing or malformed',
      });
    }

    return buildRecord({
      id,
      name,
      protocol: 'raw',
      freq: Number(block.frequency) || DEFAULT_FREQ,
      timings: values.map((v, i) => (i % 2 === 0 ? v : -v)),
    });
  }

  if (type === 'parsed') {
    const protocol = block.protocol ?? '';

    if (!isProtocolSupported(protocol)) {
      return buildRecord({
        id,
        name,
        protocol,
        skipReason: 'unsupported-protocol',
        skipDetail: `${protocol || 'unknown protocol'} is not supported`,
      });
    }

    try {
      const signal = encodeProtocol(
        protocol,
        parseHexBytesLE(block.address ?? ''),
        parseHexBytesLE(block.command ?? '')
      );

      return buildRecord({
        id,
        name,
        protocol,
        timings: signal.timings,
        freq: signal.freq,
      });
    } catch (error) {
      return buildRecord({
        id,
        name,
        protocol,
        skipReason: 'bad-data',
        skipDetail: String((error as Error).message ?? error),
      });
    }
  }

  return buildRecord({
    id,
    name,
    skipReason: 'bad-data',
    skipDetail: type ? `unknown record type "${type}"` : 'record has no type',
  });
}

export function parseFlipper(
  text: string,
  fileName?: string
): ir_parse_result_t {
  if (!/Filetype:\s*IR signals file/i.test(text)) {
    throw new IrParseError('Not a Flipper IR file');
  }

  const records: ir_record_t[] = [];
  let block: Record<string, string> | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const split = trimmed.indexOf(':');
    if (split < 0) {
      continue;
    }

    const key = trimmed.slice(0, split).trim().toLowerCase();
    const value = trimmed.slice(split + 1).trim();

    if (key === 'name') {
      if (block) {
        records.push(recordFromBlock(block, records.length));
      }
      block = { name: value };
      continue;
    }

    if (block) {
      block[key] = value;
    }
  }

  if (block) {
    records.push(recordFromBlock(block, records.length));
  }

  const base = (fileName ?? '').replace(/\.ir$/i, '');
  const underscore = base.indexOf('_');

  return {
    format: 'flipper',
    remotes: [
      {
        name: base || 'Flipper remote',
        manufacturer: underscore > 0 ? base.slice(0, underscore) : undefined,
        models: underscore > 0 ? [base.slice(underscore + 1)] : undefined,
        records,
        warnings: [],
      },
    ],
  };
}
