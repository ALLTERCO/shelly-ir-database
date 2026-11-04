// A minimal tag scanner. DOMParser is unavailable under vitest's node
// environment, and the two XML formats we read are shallow and machine
// generated, so a full parser would be dead weight.

export type xml_tag_t = {
  attrs: Record<string, string>;
  inner: string;
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    return ENTITIES[entity] ?? match;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4];
    attrs[key] = unescapeXml(value);
  }

  return attrs;
}

export function eachTag(
  xml: string,
  name: string,
  callback: (tag: xml_tag_t) => void
): void {
  const open = new RegExp(`<${name}(\\s[^>]*)?>`, 'g');
  let match: RegExpExecArray | null;

  while ((match = open.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1] ?? '');

    // The attribute run swallows a trailing slash, so self-closing tags are
    // recognised from the matched text rather than from a capture group.
    if (match[0].endsWith('/>')) {
      callback({ attrs, inner: '' });
      continue;
    }

    const bodyStart = match.index + match[0].length;
    const close = findClose(xml, name, bodyStart);

    if (close < 0) {
      callback({ attrs, inner: xml.slice(bodyStart) });
      return;
    }

    callback({ attrs, inner: xml.slice(bodyStart, close) });
    open.lastIndex = close;
  }
}

function findClose(xml: string, name: string, from: number): number {
  const scan = new RegExp(`<(/)?${name}(\\s[^>]*)?>`, 'g');
  scan.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = scan.exec(xml)) !== null) {
    if (match[1]) {
      depth -= 1;
      if (depth === 0) {
        return match.index;
      }
      continue;
    }

    if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }

  return -1;
}

export function firstTagText(xml: string, name: string): string | null {
  let found: string | null = null;

  eachTag(xml, name, tag => {
    if (found === null) {
      found = unescapeXml(tag.inner).trim();
    }
  });

  return found;
}
