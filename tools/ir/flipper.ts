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

export type flipper_code_t = {
  name: string;
  // signed µs: + carrier on, - off (as the device stores them)
  timings: number[];
  freq: number;
  // free-form ("power_on"), in its Shelly ircode line
  function?: string | null;
  // its protocol reading, written instead of the timings: one short line a
  // catalog can index (only one that encodes back to the same signal)
  parsed?: { protocol: string; address: number; command: number } | null;
};

// little-endian hex bytes, as Flipper writes an address or a command
function hexBytesLE(value: number): string {
  const bytes: string[] = [];
  for (let i = 0; i < 4; i++) {
    bytes.push(
      ((value >>> (8 * i)) & 0xff).toString(16).padStart(2, '0').toUpperCase()
    );
  }
  return bytes.join(' ');
}

// Flipper's own default: the device doesn't keep a duty cycle
const DUTY_CYCLE = '0.330000';

// a name or comment on one line of the file
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

// Unsigned durations from a mark, mark and space in turn: a code that
// starts or ends with a space loses it, and two of one kind in a row (or a
// 0) are one, so each value is read back as the kind it is.
function flipperData(timings: number[]): number[] {
  const out: number[] = [];
  let mark = true;

  for (const value of timings) {
    if (!value) continue;
    if (!out.length && value < 0) continue;
    if (value > 0 === mark) {
      out.push(Math.abs(value));
      mark = !mark;
    } else {
      out[out.length - 1] += Math.abs(value);
    }
  }
  if (out.length % 2 === 0) out.pop();

  return out;
}

export type flipper_remote_t = {
  name: string;
  // its layout ("tv"), null when it has none
  type?: string | null;
  // a line about it for whoever reads the file ("Samsung UE55, tested on …")
  title?: string;
};

// A remote's codes as a Flipper .ir file, the format of the Shelly IR
// Database's codes/ and of the Flipper databases: a code per button, parsed
// (protocol, address, command) when it has a reading, else raw. What only
// Shelly keeps is in comments other readers skip (shellyMeta): the remote's
// name and type, each code's name and function. parseFlipper reads
// it all back.
export function toFlipper(
  remote: flipper_remote_t,
  codes: flipper_code_t[]
): string {
  const lines = ['Filetype: IR signals file', 'Version: 1', '#'];
  const device: Record<string, string> = { name: oneLine(remote.name) };
  if (remote.type) device.type = remote.type;
  lines.push(`# Shelly irdevice: ${JSON.stringify(device)}`);
  if (remote.title && oneLine(remote.title))
    lines.push(`# ${oneLine(remote.title)}`);
  lines.push('#');

  for (const code of codes) {
    const p = code.parsed;
    const data = p ? [] : flipperData(code.timings);
    if (!p && !data.length) continue;
    const meta: Record<string, string> = { name: oneLine(code.name) };
    if (code.function) meta.function = code.function;
    lines.push(
      `# Shelly ircode: ${JSON.stringify(meta)}`,
      `name: ${oneLine(code.name) || 'Code'}`
    );
    if (p) {
      lines.push(
        'type: parsed',
        `protocol: ${p.protocol}`,
        `address: ${hexBytesLE(p.address)}`,
        `command: ${hexBytesLE(p.command)}`,
        '#'
      );
    } else {
      lines.push(
        'type: raw',
        `frequency: ${Math.round(code.freq) || DEFAULT_FREQ}`,
        `duty_cycle: ${DUTY_CYCLE}`,
        `data: ${data.join(' ')}`,
        '#'
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

// What a Shelly export says in its comments, which other readers skip:
// "# Shelly irdevice: {...}" once for the remote, "# Shelly ircode: {...}"
// before each code. Every field is optional; a line that isn't JSON is a
// plain comment.
type shelly_meta_t = {
  name?: unknown;
  type?: unknown;
  function?: unknown;
};

function shellyMeta(
  line: string
): ['irdevice' | 'ircode', shelly_meta_t] | null {
  const match = line.match(
    /^#\s*Shelly\s+(irdevice|ircode)\s*:\s*(\{.*\})\s*$/i
  );
  if (!match) return null;
  try {
    const meta = JSON.parse(match[2]) as unknown;
    return meta && typeof meta === 'object'
      ? [match[1].toLowerCase() as 'irdevice' | 'ircode', meta as shelly_meta_t]
      : null;
  } catch {
    return null;
  }
}

const metaText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export function parseFlipper(
  text: string,
  fileName?: string
): ir_parse_result_t {
  if (!/Filetype:\s*IR signals file/i.test(text)) {
    throw new IrParseError('Not a Flipper IR file');
  }

  const records: ir_record_t[] = [];
  let block: Record<string, string> | null = null;
  let blockMeta: shelly_meta_t | null = null;
  // an ircode line waits for the code after it
  let next: shelly_meta_t | null = null;
  let remote: shelly_meta_t | null = null;

  const close = () => {
    if (!block) return;
    const record = recordFromBlock(block, records.length);
    const fn = metaText(blockMeta?.function);
    if (fn) record.function = fn;
    records.push(record);
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const meta = shellyMeta(trimmed);
      if (meta?.[0] === 'irdevice') remote = meta[1];
      else if (meta) next = meta[1];
      continue;
    }
    if (trimmed.length === 0) {
      continue;
    }

    const split = trimmed.indexOf(':');
    if (split < 0) {
      continue;
    }

    const key = trimmed.slice(0, split).trim().toLowerCase();
    const value = trimmed.slice(split + 1).trim();

    if (key === 'name') {
      close();
      blockMeta = next;
      next = null;
      block = { name: metaText(blockMeta?.name) ?? value };
      continue;
    }

    if (block) {
      block[key] = value;
    }
  }

  close();

  const base = (fileName ?? '').replace(/\.ir$/i, '');
  const underscore = base.indexOf('_');

  return {
    format: 'flipper',
    remotes: [
      {
        name: metaText(remote?.name) ?? (base || 'Flipper remote'),
        manufacturer: underscore > 0 ? base.slice(0, underscore) : undefined,
        models: underscore > 0 ? [base.slice(underscore + 1)] : undefined,
        type: metaText(remote?.type),
        records,
        warnings: [],
      },
    ],
  };
}
