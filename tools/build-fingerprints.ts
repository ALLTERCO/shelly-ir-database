// Builds fingerprints.json: every remote in every catalogue, described well
// enough to recognise one from a button press.
//
//   npx tsx tools/build-fingerprints.ts [outFile]
//
// The parsers and the decoder under tools/ir read every catalogue's format:
// a catalogue is only as recognisable as the formats we can read.
//
// A remote contributes one of two things. If its codes decode to a protocol,
// it gets an entry per protocol and address with every command seen on it,
// which identifies a remote outright. If they decode to nothing - air
// conditioners, and captures of protocols we do not implement - it gets the
// shape of its frame instead, which narrows to a family - and with it what
// the frame's bits say, read the same way the interface reads a press
// (frameBits): a short frame's bits are the button, so every code is listed
// like a command; a long frame (an air conditioner's whole state) lists the
// bits that never change between its codes.

import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative, sep } from 'path';
import { parseIrSource } from './ir/import';
import { decodeAll, framesOf } from './ir/decode';
import type { ir_decoded_t } from './ir/decode';
import type { ir_source_format_t } from './ir/types';

type catalog_def_t = {
  id: string;
  format: ir_source_format_t;
  repo?: string;
  branch?: string;
  root: string;
  leaf: RegExp;
};

// The same sources the web interface browses.
const CATALOGS: catalog_def_t[] = [
  { id: 'flipper', format: 'flipper', repo: 'logickworkshop/Flipper-IRDB', branch: 'main', root: '', leaf: /\.ir$/i },
  { id: 'irdb', format: 'flipper', repo: 'flipperdevices/IRDB', branch: 'dev', root: 'database/categories', leaf: /\.ir$/i },
  { id: 'shelly', format: 'flipper', root: 'codes', leaf: /\.ir$/i },
  { id: 'lirc', format: 'lirc-xml', repo: 'probonopd/lirc-remotes', branch: 'xml', root: '', leaf: /\.xml$/i },
  { id: 'smartir', format: 'smartir', repo: 'smartHomeHub/SmartIR', branch: 'master', root: 'codes', leaf: /\.json$/i },
  { id: 'wigshop', format: 'wigshop', repo: 'DAB-LABS/WigShop', branch: 'main', root: 'wigs', leaf: /\.wig\.json$/i },
];


// A frame up to this long is a button: its codes are listed. A longer one
// carries state, so only the bits all its codes share are kept.
const MAX_COMMAND_BITS = 32;

type entry_t = {
  path: string;
  key: string;
  commands?: string;
  // A long frame's bits that are the same in every code: 0 or 1, and . for a
  // bit that changes.
  bits?: string;
  // How many codes the bits were taken from.
  count?: number;
  // The remote's name, for a catalogue whose file names are not one: SmartIR
  // numbers its files (codes/climate/1123.json), the name is inside.
  name?: string;
};

function leHex(value: number): string {
  const bytes: string[] = [];
  let left = value >>> 0;

  do {
    bytes.push((left & 0xff).toString(16).padStart(2, '0').toUpperCase());
    left >>>= 8;
  } while (left > 0);

  while (bytes.length > 1 && bytes[bytes.length - 1] === '00') {
    bytes.pop();
  }

  return bytes.join('');
}

function protocolKey(decoded: ir_decoded_t): string {
  return `${decoded.protocol.toUpperCase()}:${leHex(decoded.address)}`;
}

// The bits of a frame after its header, one per mark and space: by the mark
// when the marks have two lengths (pulse width), else by the space (pulse
// distance), long against short around the middle of the two. A frame
// whose pulses barely differ reads all zeroes. A press is read the same
// way when it is searched for.
function frameBits(frame: number[]): string {
  const data = frame.slice(2);
  const count = data.length >> 1;
  const marks: number[] = [];
  const spaces: number[] = [];

  for (let i = 0; i < count; i++) {
    marks.push(Math.abs(data[2 * i]));
    spaces.push(Math.abs(data[2 * i + 1]));
  }

  if (count === 0) {
    return '';
  }

  // How far a series' long pulses are from its short ones: the short level is
  // the tenth percentile, so one stray pulse cannot set it, and the long level
  // leaves out anything past four times it - the separator some air
  // conditioners put mid-frame, which would otherwise pull every real bit
  // under the middle.
  const levels = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length / 10)];
    const high = Math.max(...sorted.filter(value => value <= low * 4));

    return { low, high };
  };
  const byMark = levels(marks);
  const bySpace = levels(spaces);
  // By the mark whenever the marks have two lengths: in pulse width the
  // space is often the mark's complement, and comparing the two spreads would
  // flip between them with every capture, inverting every bit. Two lengths is
  // the longest tenth of the marks at 1.5 times the short level or more: real
  // pulse width (1300/400, Sony's 1200/600, 2000/1000 marks) has it with room
  // for a capture's jitter, which a line at twice would split a 2:1 code on;
  // equal marks (NEC's) stay within 1.2.
  const sortedMarks = [...marks].sort((a, b) => a - b);
  const useSpaces =
    sortedMarks[Math.floor((sortedMarks.length * 9) / 10)] < byMark.low * 1.5;
  const { low, high } = useSpaces ? bySpace : byMark;

  if (high < low * 1.5) {
    return '0'.repeat(count);
  }

  const middle = (low + high) / 2;

  return (useSpaces ? spaces : marks)
    .map(value => (value > middle ? '1' : '0'))
    .join('');
}

function bitsHex(bits: string): string {
  return parseInt(bits, 2).toString(16).toUpperCase();
}

// The frame shape: header mark, header space and how many bits follow. It is
// what a code that decodes to nothing can still be recognised by. Only the
// first real frame is recorded: a stored code starts at its message, and
// indexing its repeats as well would pile unrelated remotes onto the common
// shapes. A live capture is matched frame by frame instead, which is where
// the lead-in bursts turn up.
function shapesOf(timings: number[]): { key: string; bits: string }[] {
  // the frames as the interface splits a press (framesOf)
  const frames = framesOf(timings);

  // Rounded, because two captures of one remote never agree exactly.
  return frames.slice(0, 1).map(frame => ({
    key: `SHAPE:${Math.round(frame[0] / 100) * 100}/${
      Math.round(-frame[1] / 100) * 100
    }/${(frame.length - 2) >> 1}`,
    bits: frameBits(frame),
  }));
}

function walk(dir: string, leaf: RegExp): string[] {
  const out: string[] = [];

  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);

    if (statSync(full).isDirectory()) {
      out.push(...walk(full, leaf));
    } else if (leaf.test(name)) {
      out.push(full);
    }
  }

  return out;
}

function download(catalog: catalog_def_t, into: string): string {
  const url = `https://codeload.github.com/${catalog.repo}/tar.gz/refs/heads/${catalog.branch}`;

  execFileSync('curl', ['-sfL', url, '-o', join(into, 'source.tar.gz')]);
  execFileSync('tar', ['-xzf', join(into, 'source.tar.gz'), '-C', into]);

  const unpacked = readdirSync(into).find(name =>
    statSync(join(into, name)).isDirectory()
  );

  if (!unpacked) {
    throw new Error(`${catalog.id}: the archive unpacked to nothing`);
  }

  return join(into, unpacked);
}

function readRemote(catalog: catalog_def_t, text: string, file: string) {
  const protocols = new Map<string, Set<string>>();
  // Per shape, the bits of every code that has it.
  const shapes = new Map<string, Set<string>>();
  // How many codes have a frame of each length: one value from several codes
  // is a frame that never changes, not a single code.
  const lengths = new Map<number, number>();

  const parsed = parseIrSource(text, catalog.format, file);
  const first = parsed.remotes[0];
  const name =
    catalog.id === 'smartir' && first?.manufacturer
      ? [first.manufacturer, (first.models ?? []).join(', ')]
          .filter(Boolean)
          .join(' ')
      : undefined;

  for (const remote of parsed.remotes) {
    for (const record of remote.records) {
      if (record.skipReason || !record.timings?.length) {
        continue;
      }

      const readings = decodeAll(record.timings);

      if (readings.length === 0) {
        for (const shape of shapesOf(record.timings)) {
          const bits = shapes.get(shape.key) ?? new Set<string>();

          bits.add(shape.bits);
          shapes.set(shape.key, bits);
          lengths.set(
            shape.bits.length,
            (lengths.get(shape.bits.length) ?? 0) + 1
          );
        }

        continue;
      }

      for (const reading of readings) {
        const key = protocolKey(reading);
        const commands = protocols.get(key) ?? new Set<string>();

        commands.add(leHex(reading.command));
        protocols.set(key, commands);
      }
    }
  }

  return { protocols, shapes, lengths, name };
}

// A generated remote's codes (codes/ACs, from IRremoteESP8266) change only
// mode, fan and temperature; everything else is left at its default, so the
// bits of the swing, quiet, the clock... look fixed and a real remote set
// another way disagrees there. <file>.variations.json holds the same remote
// with each of those settings changed, read here only to learn which bits are
// settings: they are not codes.
function variationBits(file: string): string[] {
  const sidecar = file.replace(/\.ir$/i, '.variations.json');

  if (sidecar === file || !existsSync(sidecar)) {
    return [];
  }

  const data = JSON.parse(readFileSync(sidecar, 'utf8')) as {
    variations?: Record<string, number[]>;
  };

  return Object.values(data.variations ?? {}).flatMap(timings =>
    shapesOf(timings).map(shape => shape.bits)
  );
}

// What a shape entry says about its codes: each one when a frame is a button,
// the bits they all share when it carries state. One code of a long frame
// says nothing about which of its bits change: a remote of just that code is
// held to all of them (it is all it sends); several
// codes with the same frame (a header frame that opens every code, the
// state following in the next) fix all of its bits. `total` is how many
// codes have the frame. `settings` are frames of the same remote with other
// settings: they mark bits as changing, but are not counted or listed.
function shapeData(
  codes: Set<string>,
  total: number,
  settings: string[] = []
): Partial<entry_t> {
  const list = [...codes];
  const length = list[0]?.length ?? 0;

  if (length === 0) {
    return {};
  }

  if (length <= MAX_COMMAND_BITS) {
    return { commands: [...new Set(list.map(bitsHex))].sort().join(' ') };
  }

  const same = settings.filter(code => code.length === length);

  // one code alone (the remote has just it): its bits are all it sends,
  // every one of them held
  if (total + same.length < 2) {
    return { bits: list[0], count: total };
  }

  const all = [...list, ...same];
  let bits = '';

  for (let i = 0; i < length; i++) {
    const bit = all[0][i];

    bits += all.every(code => code[i] === bit) ? bit : '.';
  }

  return { bits, count: total };
}

function main() {
  const outFile = process.argv[2] ?? 'fingerprints.json';

  const entries: entry_t[] = [];
  const stats: Record<string, { files: number; decoded: number; shaped: number }> = {};
  const temp = mkdtempSync(join(tmpdir(), 'ir-fp-'));

  // The parsers warn about every code they cannot import, which is useful in
  // the interface and deafening over seventeen thousand files.
  const warn = console.warn;
  console.warn = () => {};

  try {
    for (const catalog of CATALOGS) {
      const base = catalog.repo
        ? download(catalog, mkdtempSync(join(temp, 's-')))
        : '.';
      const files = walk(join(base, catalog.root), catalog.leaf);
      const seen = { files: files.length, decoded: 0, shaped: 0 };

      for (const file of files) {
        const path = relative(base, file).split(sep).join('/');
        let found;

        try {
          found = {
            ...readRemote(catalog, readFileSync(file, 'utf8'), file),
            settings: variationBits(file),
          };
        } catch {
          // A file we cannot read is simply not in the index.
          continue;
        }

        for (const [key, commands] of found.protocols) {
          entries.push({
            path: `${catalog.id}:${path}`,
            key,
            commands: [...commands].sort().join(' '),
            ...(found.name ? { name: found.name } : {}),
          });
        }

        // The shape is what a code that decodes to nothing is found by: a
        // remote with some codes in a protocol and others in none (a TV box
        // whose few NEC codes decode) is found by either.
        if (found.protocols.size > 0) {
          seen.decoded += 1;
        }
        if (found.shapes.size > 0) {
          seen.shaped += 1;

          // Two codes of one remote round to neighbouring keys whenever their
          // headers fall either side of a boundary, so what the bits say is
          // taken over every code of the same length, not per key.
          const byLength = new Map<number, Set<string>>();

          for (const codes of found.shapes.values()) {
            for (const code of codes) {
              const same = byLength.get(code.length) ?? new Set<string>();

              same.add(code);
              byLength.set(code.length, same);
            }
          }

          for (const [key, codes] of found.shapes) {
            const length = [...codes][0]?.length ?? 0;

            entries.push({
              path: `${catalog.id}:${path}`,
              key,
              ...shapeData(
                byLength.get(length) ?? codes,
                found.lengths.get(length) ?? codes.size,
                found.settings
              ),
              ...(found.name ? { name: found.name } : {}),
            });
          }
        }
      }

      stats[catalog.id] = seen;
      console.log(
        `${catalog.id}: ${seen.decoded} decoded, ${seen.shaped} by shape, of ${seen.files} files`
      );
    }
  } finally {
    console.warn = warn;
    rmSync(temp, { recursive: true, force: true });
  }

  entries.sort((a, b) =>
    a.key === b.key ? (a.path < b.path ? -1 : 1) : a.key < b.key ? -1 : 1
  );

  writeFileSync(
    outFile,
    `${JSON.stringify({
      generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      sources: stats,
      entries,
    })}\n`
  );

  const remotes = new Set(entries.map(entry => entry.path)).size;
  console.log(`\n${entries.length} entries, ${remotes} remotes -> ${outFile}`);
}

main();
