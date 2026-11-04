// Builds index.json, a single file describing every remote in codes/, so a
// client can search the database without walking the repository tree.
//
//   npx tsx tools/build-index.ts [outFile]
//
// Only what the path cannot already give is written out: the path itself is
// the category, brand and remote name.

import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = 'codes';

// A protocol's frame shape, taken from the captures themselves. It is what
// lets a client say "this is a Gree-family air conditioner" for a code that
// decodes to no remote protocol at all - every AC file here is a raw capture
// with no address or command to match on.
type signature_t = {
  protocol: string;
  mark: number;
  space: number;
  bits: number;
  gap: number;
  remotes: number;
};

type remote_t = {
  path: string;
  updated?: string;
  codes: number;
  protocol?: string;
  aliases?: string[];
  models?: string[];
};

function walk(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.ir$/i.test(entry)) {
      out.push(full);
    }
  }

  return out;
}

// When the codes themselves last changed, which is what tells a reader how
// stale the data is - the index is rebuilt nightly whether or not anything moved.
function lastChanged(file: string): string | undefined {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      encoding: 'utf8',
    }).trim();

    return out ? out.replace(/\.\d+/, '') : undefined;
  } catch {
    return undefined;
  }
}

const FRAME_GAP_US = 8000;

// Bits in the first block, and the gap that closes it. Those two separate the
// protocols that share a header: Gree, Electra and Kelon all open 9000/4500.
function frameShape(timings: number[]): { bits: number; gap: number } {
  let count = 0;

  for (const value of timings.slice(2)) {
    if (value < 0 && -value >= FRAME_GAP_US) {
      return { bits: count >> 1, gap: Math.round(-value / 1000) * 1000 };
    }

    count += 1;
  }

  return { bits: count >> 1, gap: 0 };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);

  return Math.round(sorted[sorted.length >> 1]);
}

function headerList(header: string, field: string): string[] | undefined {
  const match = new RegExp(`^#\\s*${field}:\\s*(.+)$`, 'mi').exec(header);
  const values = match?.[1]
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return values?.length ? values : undefined;
}

function readRemote(file: string): {
  remote: remote_t;
  problems: string[];
  captures: number[][];
} {
  const text = readFileSync(file, 'utf8');
  const header = text.slice(0, text.search(/^name:/m) + 1 || text.length);
  const names = [...text.matchAll(/^name:\s*(.+)$/gm)].map(m => m[1].trim());
  const problems: string[] = [];

  if (names.length === 0) {
    problems.push('no codes');
  }

  // StoreCode rejects a duplicate name within one IR device, so a file
  // carrying one cannot be imported whole.
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length > 0) {
    problems.push(`duplicate names: ${[...new Set(duplicates)].join(', ')}`);
  }

  // Raw files name their protocol in the header; parsed files carry it per
  // code, and a remote is free to mix several.
  const perCode = [...text.matchAll(/^protocol:\s*(.+)$/gm)].map(m =>
    m[1].trim()
  );
  const protocol =
    [...new Set(perCode)].sort().join(', ') ||
    /^#\s*Protocol:\s*(.+)$/mi.exec(header)?.[1].trim();

  const captures = [...text.matchAll(/^data:\s*(.+)$/gm)].map(match =>
    match[1]
      .trim()
      .split(/\s+/)
      .map((value, i) => (i % 2 === 0 ? Number(value) : -Number(value)))
  );

  return {
    captures,
    remote: {
      path: relative('.', file).split(sep).join('/'),
      updated: lastChanged(file),
      codes: names.length,
      protocol: protocol || undefined,
      aliases: headerList(header, 'Also sold as'),
      models: headerList(header, 'Models'),
    },
    problems,
  };
}

function main() {
  const outFile = process.argv[2] ?? 'index.json';
  const remotes: remote_t[] = [];
  const broken: string[] = [];
  let codes = 0;

  const shapes = new Map<
    string,
    { mark: number[]; space: number[]; shape: Map<string, number>; files: Set<string> }
  >();

  for (const file of walk(ROOT)) {
    const { remote, problems, captures } = readRemote(file);

    if (problems.length > 0) {
      broken.push(`${remote.path}: ${problems.join('; ')}`);
      continue;
    }

    remotes.push(remote);
    codes += remote.codes;

    if (!remote.protocol) {
      continue;
    }

    const entry = shapes.get(remote.protocol) ?? {
      mark: [],
      space: [],
      shape: new Map<string, number>(),
      files: new Set<string>(),
    };

    for (const timings of captures) {
      if (timings.length < 4 || !(timings[0] > 0)) {
        continue;
      }

      const { bits, gap } = frameShape(timings);
      const key = `${bits}:${gap}`;

      entry.mark.push(timings[0]);
      entry.space.push(-timings[1]);
      entry.shape.set(key, (entry.shape.get(key) ?? 0) + 1);
    }

    entry.files.add(remote.path);
    shapes.set(remote.protocol, entry);
  }

  const signatures: signature_t[] = [];

  for (const [protocol, entry] of [...shapes].sort()) {
    if (entry.mark.length === 0) {
      continue;
    }

    // The commonest shape, because a handful of codes in a file are oddities.
    const [key] = [...entry.shape].sort((a, b) => b[1] - a[1])[0];
    const [bits, gap] = key.split(':').map(Number);

    signatures.push({
      protocol,
      mark: median(entry.mark),
      space: median(entry.space),
      bits,
      gap,
      remotes: entry.files.size,
    });
  }

  const index = {
    // When this file was built, and when the newest code in it last changed.
    generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    updated: remotes
      .map(remote => remote.updated)
      .filter(Boolean)
      .sort()
      .pop(),
    files: remotes.length,
    codes,
    signatures,
    remotes,
  };

  writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`${remotes.length} remotes, ${codes} codes -> ${outFile}`);

  if (broken.length > 0) {
    console.error(`\n${broken.length} file(s) left out:`);
    broken.forEach(line => console.error(`  ${line}`));
    process.exit(1);
  }
}

main();
