import { DEFAULT_FREQ, IrParseError } from './types';
import type { ir_parse_result_t, ir_record_t, ir_remote_t } from './types';
import { buildRecord } from './record';
import { prontoToTimings } from './pronto';
import { encodeProtocol } from './protocols';
import { eachTag, firstTagText } from './xml-lite';

const GIRR_PROTOCOLS: Record<string, string> = {
  nec1: 'NEC',
  rc5: 'RC5',
  rc6: 'RC6',
  sony12: 'SIRC',
  sony15: 'SIRC15',
  sony20: 'SIRC20',
};

function parseDurations(text: string | null): number[] {
  if (!text) {
    return [];
  }

  const values = text.trim().split(/\s+/).filter(Boolean).map(Number);

  return values.every(v => Number.isFinite(v)) ? values : [];
}

function fromParameters(inner: string): { protocol: string; signal: ReturnType<typeof encodeProtocol> } | null {
  let protocolName = '';
  const params: Record<string, number> = {};

  eachTag(inner, 'parameters', tag => {
    protocolName = protocolName || (tag.attrs.protocol ?? '').toLowerCase();
    eachTag(tag.inner, 'parameter', param => {
      const name = (param.attrs.name ?? '').toUpperCase();
      const value = Number(param.attrs.value);
      if (name && Number.isFinite(value)) {
        params[name] = value;
      }
    });
  });

  const mapped = GIRR_PROTOCOLS[protocolName];
  if (!mapped || params.F === undefined || params.D === undefined) {
    return null;
  }

  const address =
    mapped === 'NEC' && params.S !== undefined
      ? (params.D & 0xff) | ((params.S & 0xff) << 8)
      : params.D;
  const protocol = mapped === 'NEC' && params.S !== undefined ? 'NECext' : mapped;

  return { protocol, signal: encodeProtocol(protocol, address, params.F) };
}

export function parseGirr(text: string): ir_parse_result_t {
  if (!/<(remotes|remote|commandSet)[\s>]/.test(text)) {
    throw new IrParseError('Not a Girr document');
  }

  const remotes: ir_remote_t[] = [];

  eachTag(text, 'remote', remote => {
    const records: ir_record_t[] = [];

    eachTag(remote.inner, 'commandSet', set => {
      const group = set.attrs.name;

      eachTag(set.inner, 'command', command => {
        const name = command.attrs.name ?? '';
        const id = `girr-${remotes.length}-${records.length}`;
        let freq = DEFAULT_FREQ;
        let timings: number[] = [];

        eachTag(command.inner, 'raw', raw => {
          if (timings.length > 0) {
            return;
          }
          freq = Number(raw.attrs.frequency) || DEFAULT_FREQ;
          const intro = parseDurations(firstTagText(raw.inner, 'intro'));
          timings = intro.length > 0
            ? intro
            : parseDurations(firstTagText(raw.inner, 'repeat'));
        });

        if (timings.length > 0) {
          records.push(
            buildRecord({ id, name, group, protocol: 'raw', timings, freq })
          );
          return;
        }

        const pronto = firstTagText(command.inner, 'pronto');
        if (pronto) {
          try {
            const decoded = prontoToTimings(pronto);
            records.push(
              buildRecord({
                id,
                name,
                group,
                protocol: 'pronto',
                timings: decoded.timings,
                freq: decoded.freq,
              })
            );
            return;
          } catch {
            // fall through to the parameter form
          }
        }

        try {
          const encoded = fromParameters(command.inner);
          if (encoded) {
            records.push(
              buildRecord({
                id,
                name,
                group,
                protocol: encoded.protocol,
                timings: encoded.signal.timings,
                freq: encoded.signal.freq,
              })
            );
            return;
          }
        } catch {
          // reported as unsupported below
        }

        records.push(
          buildRecord({
            id,
            name,
            group,
            skipReason: 'unsupported-protocol',
            skipDetail: 'no raw, Pronto or supported protocol form',
          })
        );
      });
    });

    remotes.push({
      name: remote.attrs.name ?? 'Girr remote',
      manufacturer: remote.attrs.manufacturer,
      models: remote.attrs.model ? [remote.attrs.model] : undefined,
      records,
      warnings: [],
    });
  });

  if (remotes.length === 0) {
    throw new IrParseError('Girr document carries no remotes');
  }

  return { format: 'girr', remotes };
}
