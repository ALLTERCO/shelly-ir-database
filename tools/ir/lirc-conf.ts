import { DEFAULT_FREQ, IrParseError } from './types';
import type { ir_parse_result_t, ir_record_t, ir_remote_t } from './types';
import { buildRecord } from './record';

type lirc_remote_t = {
  name: string;
  flags: string[];
  bits: number;
  frequency: number;
  header?: [number, number];
  one: [number, number];
  zero: [number, number];
  plead: number;
  ptrail: number;
  preDataBits: number;
  preData: bigint;
  postDataBits: number;
  postData: bigint;
  pre?: [number, number];
  post?: [number, number];
  codes: Array<{ name: string; value: bigint }>;
  rawCodes: Array<{ name: string; timings: number[] }>;
};

const SUPPORTED_FLAGS = ['SPACE_ENC', 'RAW_CODES'];

function toBigInt(token: string): bigint {
  const clean = token.trim();

  try {
    if (/^0x/i.test(clean)) {
      return BigInt(clean);
    }
    return BigInt(clean.replace(/^0+(?=\d)/, ''));
  } catch {
    return 0n;
  }
}

function emptyRemote(): lirc_remote_t {
  return {
    name: 'LIRC remote',
    flags: [],
    bits: 0,
    frequency: DEFAULT_FREQ,
    one: [0, 0],
    zero: [0, 0],
    plead: 0,
    ptrail: 0,
    preDataBits: 0,
    preData: 0n,
    postDataBits: 0,
    postData: 0n,
    codes: [],
    rawCodes: [],
  };
}

function pushBits(
  out: number[],
  remote: lirc_remote_t,
  value: bigint,
  bits: number
): void {
  for (let i = bits - 1; i >= 0; i--) {
    const bit = (value >> BigInt(i)) & 1n;
    const [mark, space] = bit ? remote.one : remote.zero;
    if (mark > 0) {
      out.push(mark);
    }
    if (space > 0) {
      out.push(-space);
    }
  }
}

// Mirrors the emission order of LIRC's own transmit path.
export function encodeSpaceEnc(remote: lirc_remote_t, value: bigint): number[] {
  const out: number[] = [];

  if (remote.plead > 0) {
    out.push(remote.plead);
  }
  if (remote.header) {
    out.push(remote.header[0], -remote.header[1]);
  }
  if (remote.preDataBits > 0) {
    pushBits(out, remote, remote.preData, remote.preDataBits);
  }
  if (remote.pre) {
    out.push(remote.pre[0], -remote.pre[1]);
  }

  pushBits(out, remote, value, remote.bits);

  if (remote.postDataBits > 0) {
    pushBits(out, remote, remote.postData, remote.postDataBits);
  }
  if (remote.post) {
    out.push(remote.post[0], -remote.post[1]);
  }
  if (remote.ptrail > 0) {
    out.push(remote.ptrail);
  }

  return out;
}

function toRecords(remote: lirc_remote_t, index: number): ir_record_t[] {
  const isRaw = remote.flags.includes('RAW_CODES');
  const supported = remote.flags.some(flag => SUPPORTED_FLAGS.includes(flag));

  if (isRaw) {
    return remote.rawCodes.map((code, i) =>
      buildRecord({
        id: `lirc-${index}-${i}`,
        name: code.name,
        protocol: 'raw',
        freq: remote.frequency,
        timings: code.timings.map((v, n) => (n % 2 === 0 ? v : -v)),
      })
    );
  }

  return remote.codes.map((code, i) => {
    const id = `lirc-${index}-${i}`;

    if (!supported) {
      return buildRecord({
        id,
        name: code.name,
        skipReason: 'unsupported-encoding',
        skipDetail: `LIRC flags ${remote.flags.join('|') || 'unset'} are not supported`,
      });
    }

    if (remote.bits <= 0 || remote.one[0] + remote.one[1] === 0) {
      return buildRecord({
        id,
        name: code.name,
        skipReason: 'bad-data',
        skipDetail: 'remote is missing bit timings',
      });
    }

    return buildRecord({
      id,
      name: code.name,
      protocol: 'lirc',
      freq: remote.frequency,
      timings: encodeSpaceEnc(remote, code.value),
    });
  });
}

export function parseLircConf(text: string): ir_parse_result_t {
  if (!/^\s*begin\s+remote/m.test(text)) {
    throw new IrParseError('Not a lircd.conf file');
  }

  const remotes: ir_remote_t[] = [];
  let remote: lirc_remote_t | null = null;
  let section: 'none' | 'codes' | 'raw' = 'none';
  let rawName = '';
  let rawTimings: number[] = [];

  const flushRaw = () => {
    if (remote && rawName) {
      remote.rawCodes.push({ name: rawName, timings: rawTimings });
    }
    rawName = '';
    rawTimings = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (trimmed.length === 0) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    const key = parts[0].toLowerCase();

    if (key === 'begin' && parts[1] === 'remote') {
      remote = emptyRemote();
      continue;
    }

    if (!remote) {
      continue;
    }

    if (key === 'end' && parts[1] === 'remote') {
      flushRaw();
      remotes.push({
        name: remote.name,
        records: toRecords(remote, remotes.length),
        warnings: [],
      });
      remote = null;
      section = 'none';
      continue;
    }

    if (key === 'begin') {
      section = parts[1] === 'raw_codes' ? 'raw' : 'codes';
      continue;
    }

    if (key === 'end') {
      if (section === 'raw') {
        flushRaw();
      }
      section = 'none';
      continue;
    }

    if (section === 'raw') {
      if (key === 'name') {
        flushRaw();
        rawName = parts[1] ?? '';
        continue;
      }
      for (const token of parts) {
        const value = Number(token);
        if (Number.isFinite(value) && value > 0) {
          rawTimings.push(value);
        }
      }
      continue;
    }

    if (section === 'codes') {
      if (parts.length >= 2) {
        remote.codes.push({ name: parts[0], value: toBigInt(parts[1]) });
      }
      continue;
    }

    switch (key) {
      case 'name':
        remote.name = parts[1] ?? remote.name;
        break;
      case 'flags':
        remote.flags = (parts[1] ?? '').split('|').map(f => f.trim().toUpperCase());
        break;
      case 'bits':
        remote.bits = Number(parts[1]) || 0;
        break;
      case 'frequency':
        remote.frequency = Number(parts[1]) || DEFAULT_FREQ;
        break;
      case 'header':
        remote.header = [Number(parts[1]) || 0, Number(parts[2]) || 0];
        break;
      case 'one':
        remote.one = [Number(parts[1]) || 0, Number(parts[2]) || 0];
        break;
      case 'zero':
        remote.zero = [Number(parts[1]) || 0, Number(parts[2]) || 0];
        break;
      case 'pre':
        remote.pre = [Number(parts[1]) || 0, Number(parts[2]) || 0];
        break;
      case 'post':
        remote.post = [Number(parts[1]) || 0, Number(parts[2]) || 0];
        break;
      case 'plead':
        remote.plead = Number(parts[1]) || 0;
        break;
      case 'ptrail':
        remote.ptrail = Number(parts[1]) || 0;
        break;
      case 'pre_data_bits':
        remote.preDataBits = Number(parts[1]) || 0;
        break;
      case 'pre_data':
        remote.preData = toBigInt(parts[1] ?? '0');
        break;
      case 'post_data_bits':
        remote.postDataBits = Number(parts[1]) || 0;
        break;
      case 'post_data':
        remote.postData = toBigInt(parts[1] ?? '0');
        break;
      default:
        break;
    }
  }

  if (remotes.length === 0) {
    throw new IrParseError('lircd.conf carries no remotes');
  }

  return { format: 'lirc-conf', remotes };
}
