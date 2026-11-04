import { IrParseError } from './types';
import type { ir_parse_result_t, ir_record_t, ir_remote_t } from './types';
import { buildRecord } from './record';
import { prontoToTimings } from './pronto';
import { eachTag, firstTagText } from './xml-lite';

// The probonopd/lirc-remotes mirror ships the LIRC database pre-converted to
// XML in which every code already carries a Pronto CCF string, so the whole
// catalogue decodes through the Pronto path.
export function parseLircXml(text: string): ir_parse_result_t {
  if (!/<lircremotes[\s>]/.test(text)) {
    throw new IrParseError('Not a LIRC XML export');
  }

  const remotes: ir_remote_t[] = [];

  eachTag(text, 'remote', remote => {
    const records: ir_record_t[] = [];

    eachTag(remote.inner, 'code', code => {
      const name = code.attrs.name ?? '';
      const ccf = firstTagText(code.inner, 'ccf');
      const id = `lirc-${remotes.length}-${records.length}`;

      if (!ccf) {
        records.push(
          buildRecord({
            id,
            name,
            skipReason: 'bad-data',
            skipDetail: 'entry carries no Pronto code',
          })
        );
        return;
      }

      let protocol: string | undefined;
      eachTag(code.inner, 'decoding', decoding => {
        protocol = protocol ?? decoding.attrs.protocol;
      });

      try {
        const signal = prontoToTimings(ccf);
        records.push(
          buildRecord({
            id,
            name,
            protocol,
            timings: signal.timings,
            freq: signal.freq,
          })
        );
      } catch (error) {
        records.push(
          buildRecord({
            id,
            name,
            protocol,
            skipReason: 'unsupported-pronto',
            skipDetail: String((error as Error).message ?? error),
          })
        );
      }
    });

    remotes.push({
      name: remote.attrs.name ?? 'LIRC remote',
      records,
      warnings: [],
    });
  });

  if (remotes.length === 0) {
    throw new IrParseError('LIRC XML export carries no remotes');
  }

  return { format: 'lirc-xml', remotes };
}
