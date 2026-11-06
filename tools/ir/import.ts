import { IrParseError } from './types';
import type {
  ir_parse_result_t,
  ir_record_t,
  ir_signal_format_t,
  ir_signal_t,
  ir_source_format_t,
} from './types';
import { detectFormat } from './detect';
import { parseFlipper } from './flipper';
import { parseGirr } from './girr';
import { parseLircConf } from './lirc-conf';
import { parseLircXml } from './lirc-xml';
import { parseSmartIr } from './smartir';
import { parseWigshop } from './wigshop';
import { prontoToTimings } from './pronto';
import { broadlinkToTimings } from './broadlink';
import { normaliseTimings } from './timings';
import { DEFAULT_FREQ } from './types';

export function parseIrSource(
  text: string,
  format?: ir_source_format_t | null,
  fileName?: string
): ir_parse_result_t {
  const resolved = format ?? detectFormat(text, fileName);

  if (!resolved) {
    throw new IrParseError('Could not tell what kind of IR file this is');
  }

  switch (resolved) {
    case 'flipper':
      return parseFlipper(text, fileName);
    case 'lirc-xml':
      return parseLircXml(text);
    case 'lirc-conf':
      return parseLircConf(text);
    case 'girr':
      return parseGirr(text);
    case 'smartir':
      return parseSmartIr(text);
    case 'wigshop':
      return parseWigshop(text);
    default:
      throw new IrParseError(`Unsupported format "${resolved}"`);
  }
}

// Pronto is four-hex-digit words, Broadlink is base64, anything else is a
// list of numbers - enough to tell apart what a person pastes.
export function detectSignalFormat(text: string): ir_signal_format_t {
  const trimmed = text.trim();

  if (/^(?:[0-9a-f]{4}\s+){3}[0-9a-f]{4}/i.test(trimmed)) {
    return 'pronto';
  }

  if (
    /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed.replace(/\s+/g, '')) &&
    /[A-Za-z+/=]/.test(trimmed)
  ) {
    return 'broadlink';
  }

  return 'raw';
}

export function parseSignal(
  text: string,
  format: ir_signal_format_t
): ir_signal_t {
  if (format === 'pronto') {
    return prontoToTimings(text);
  }

  if (format === 'broadlink') {
    return broadlinkToTimings(text);
  }

  const values = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);

  if (values.length === 0 || values.some(v => !Number.isFinite(v))) {
    throw new Error('Timings must be a list of numbers');
  }

  // A list with no negative value is unsigned mark/space, the way Flipper and
  // LIRC write it; otherwise the signs are already meaningful.
  const signed = values.some(v => v < 0)
    ? values
    : values.map((v, i) => (i % 2 === 0 ? v : -v));

  return { timings: normaliseTimings(signed), freq: DEFAULT_FREQ };
}

export function dedupeRecords(
  records: ir_record_t[],
  existingNames: string[] = []
): ir_record_t[] {
  const taken = new Set(existingNames);
  const seen = new Map<string, ir_record_t>();

  return records.map(record => {
    if (record.skipReason) {
      return record;
    }

    const signature = `${record.name}\u0000${record.freq}\u0000${record.timings.join(',')}`;
    if (seen.has(signature)) {
      return {
        ...record,
        skipReason: 'duplicate',
        skipDetail: 'identical to an earlier code in this file',
      };
    }
    seen.set(signature, record);

    if (!taken.has(record.name)) {
      taken.add(record.name);
      return record;
    }

    let suffix = 2;
    let candidate = `${record.name}_${suffix}`;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `${record.name}_${suffix}`;
    }
    taken.add(candidate);

    return { ...record, name: candidate };
  });
}

export function importableRecords(records: ir_record_t[]): ir_record_t[] {
  return records.filter(record => !record.skipReason);
}

export function toStoreCodeParams(
  deviceId: number,
  record: ir_record_t
): { id: number; name: string; timings: number[]; freq: number } {
  return {
    id: deviceId,
    name: record.name,
    timings: record.timings,
    freq: record.freq,
  };
}

// A file's code name for people (actions and schedules show it): LIRC's
// KEY_ goes, underscores are spaces, the first letter is a capital
// ("KEY_VOLUMEUP" "VOLUMEUP", "vol_up" "Vol up"); else as it is
export function niceCodeName(raw: string): string {
  const s = raw
    .trim()
    .replace(/^KEY_(?=.)/i, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : raw;
}

// A remote's name for people from a file's or a catalog's: underscores as
// spaces, the words that say nothing left out (SmartIR's "Unknown model",
// Flipper's "TCL_UnknownModel2", "Unknown_brand", "Unkown"), and a note in
// brackets (SmartIR's "(62–86°F; Home Assistant must use Fahrenheit)",
// how to set it up there); a brand alone
// (or nothing) gets the kind of remote after it: "Gree air conditioner"
const UNKNOWN = /^un?kn?own(model|brand)?\d*$/i;
export function niceRemoteName(raw: string, kind?: string): string {
  const words = raw
    .replace(/\s*\([^)]*\)/g, ' ')
    .replace(/[_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (UNKNOWN.test(w)) {
      // "Unknown model 2": its model word and number go with it
      while (/^(model|brand|\d+)$/i.test(words[i + 1] ?? '')) i++;
      continue;
    }
    kept.push(w);
  }
  // a number left alone after them says nothing either
  const name = kept.filter(w => !/^\d+$/.test(w) || kept.length > 2).join(' ');
  // nothing left and no kind: a plain word, not "Unknown1"
  if (!kind || name.split(' ').length > 1) return name || 'Remote';
  const k = kind === kind.toUpperCase() ? kind : kind.toLowerCase();
  return name ? `${name} ${k}` : kind;
}
