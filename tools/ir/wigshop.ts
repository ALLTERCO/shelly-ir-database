import { IrParseError } from './types';
import type { ir_parse_result_t, ir_record_t } from './types';
import { buildRecord } from './record';
import { prontoToTimings } from './pronto';

type wig_signal_t = {
  alias?: string;
  pronto?: string;
  send_count?: number;
  ditto_count?: number;
};

type wig_t = {
  format?: string;
  name?: string;
  brand?: string;
  model?: string;
  kind?: string;
  signals?: wig_signal_t[];
};

export function parseWigshop(text: string): ir_parse_result_t {
  let wig: wig_t;

  try {
    wig = JSON.parse(text) as wig_t;
  } catch {
    throw new IrParseError('Not valid JSON');
  }

  if (
    !wig ||
    typeof wig.format !== 'string' ||
    !wig.format.startsWith('hair-wig')
  ) {
    throw new IrParseError('Not a WigShop wig');
  }

  const signals = Array.isArray(wig.signals) ? wig.signals : [];
  const records: ir_record_t[] = signals.map((signal, index) => {
    const id = `wig-${index}`;
    const name = signal.alias ?? `Code ${index + 1}`;
    const warnings =
      signal.send_count && signal.send_count > 1
        ? [`the remote sends this ${signal.send_count} times per press`]
        : undefined;

    if (typeof signal.pronto !== 'string') {
      return buildRecord({
        id,
        name,
        skipReason: 'bad-data',
        skipDetail: 'signal carries no Pronto code',
      });
    }

    try {
      const decoded = prontoToTimings(signal.pronto);
      return buildRecord({
        id,
        name,
        protocol: 'pronto',
        timings: decoded.timings,
        freq: decoded.freq,
        warnings,
      });
    } catch (error) {
      return buildRecord({
        id,
        name,
        skipReason: 'unsupported-pronto',
        skipDetail: String((error as Error).message ?? error),
      });
    }
  });

  return {
    format: 'wigshop',
    remotes: [
      {
        name: wig.name ?? 'Wig',
        manufacturer: wig.brand,
        models: wig.model ? [wig.model] : undefined,
        records,
        warnings: [],
      },
    ],
  };
}
