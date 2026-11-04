import type { ir_source_format_t } from './types';

export function detectFormat(
  text: string,
  fileName?: string
): ir_source_format_t | null {
  const head = text.slice(0, 4096);
  const trimmed = head.trimStart();

  if (/Filetype:\s*IR signals file/i.test(head)) {
    return 'flipper';
  }

  if (trimmed.startsWith('<')) {
    if (/<lircremotes[\s>]/.test(head)) {
      return 'lirc-xml';
    }
    if (/<(girr|remotes|remote|commandSet)[\s>]/.test(head)) {
      return 'girr';
    }
    return null;
  }

  if (trimmed.startsWith('{')) {
    if (/"format"\s*:\s*"hair-wig/.test(head)) {
      return 'wigshop';
    }
    if (/"(commandsEncoding|supportedController)"/.test(head)) {
      return 'smartir';
    }
    return null;
  }

  if (/^\s*begin\s+remote/m.test(head)) {
    return 'lirc-conf';
  }

  const name = (fileName ?? '').toLowerCase();
  if (name.endsWith('.ir')) {
    return 'flipper';
  }
  if (name.endsWith('.conf')) {
    return 'lirc-conf';
  }

  return null;
}
