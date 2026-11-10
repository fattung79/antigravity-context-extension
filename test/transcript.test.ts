import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTranscript, type FileIo } from '../src/sources/file';
import { TranscriptParser } from '../src/sources/transcript';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', n));

function parse(name: string): TranscriptParser {
  const p = new TranscriptParser();
  p.ingest(fx(name));
  return p;
}

describe('TranscriptParser', () => {
  it('computes used = input + cache_read of the last planner step', () => {
    const s = parse('transcript-basic.jsonl').summary();
    expect(s.used).toBe(6600);
    expect(s.totals).toEqual({ input: 6100, cacheRead: 4500, output: 70, calls: 2 });
    expect(s.firstPrompt).toBe('Fix the WSL path handling in the build script please');
  });

  it('handles a partial last line and resumes', () => {
    const data = fx('transcript-basic.jsonl');
    const cut = data.length - 20;
    const p = new TranscriptParser();
    const consumed = p.ingest(data.subarray(0, cut));
    expect(data[consumed - 1]).toBe(0x0a);
    expect(p.summary().used).toBe(4000);
    p.ingest(data.subarray(p.offset));
    expect(p.offset).toBe(data.length);
    expect(p.summary().used).toBe(6600);
  });

  it('returns 0 consumed for a single unterminated line', () => {
    const p = new TranscriptParser();
    expect(p.ingest(Buffer.from('{"step_index":0'))).toBe(0);
    expect(p.offset).toBe(0);
  });

  it('applies the rewind rule', () => {
    const p = parse('transcript-rewind.jsonl');
    expect(p.kept.map((k) => k.index)).toEqual([0, 1, 2, 3]);
    expect(p.summary().used).toBe(1000);
    expect(p.summary().totals.calls).toBe(2);
  });

  // Two runs writing into one transcript (leftover server, spec 13). Planner tokens tag the run:
  // run A uses input = 1000 + index, run B uses input = 5000 + index.
  const ln = (i: number, run: 'A' | 'B', type = 'PLANNER_RESPONSE') => JSON.stringify(
    type === 'USER_INPUT'
      ? { step_index: i, source: 'USER_EXPLICIT', type, content: `<USER_REQUEST>${run}</USER_REQUEST>` }
      : { step_index: i, source: 'MODEL', type, input_tokens: (run === 'A' ? 1000 : 5000) + i, cache_read_tokens: 0, output_tokens: 1 },
  );
  const feed = (lines: string[]) => { const p = new TranscriptParser(); p.ingest(Buffer.from(lines.join('\n') + '\n')); return p; };
  const runOf = (p: TranscriptParser) => p.kept.map((k) => (k.tokens ? (k.tokens.input >= 5000 ? 'B' : 'A') : 'u') + k.index);

  it('interleaved runs: a late lower step from another run does not drop the live run (real 16c7dd2b pattern)', () => {
    const A = (i: number) => ln(i, 'A');
    const lines = [ln(0, 'A', 'USER_INPUT'), A(1), A(2), A(3), A(4), A(5), A(6), A(7), A(8),
      ln(4, 'B', 'USER_INPUT'), ln(5, 'B'), A(9), ln(6, 'B'), A(10)];
    expect(runOf(feed(lines))).toEqual(['u0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10']);
    expect(feed(lines).summary().used).toBe(1010);
  });

  it('interleaved runs: follows the run that wrote the last line, back through its own steps', () => {
    const lines = [ln(0, 'A', 'USER_INPUT'), ln(1, 'A'), ln(2, 'A'), ln(3, 'A'),
      ln(2, 'B', 'USER_INPUT'), ln(4, 'A'), ln(3, 'B'), ln(5, 'A'), ln(4, 'B')];
    // Last line is B4: B4 <- B3 <- u2 (B's user input) <- A1 <- u0.
    expect(runOf(feed(lines))).toEqual(['u0', 'A1', 'u2', 'B3', 'B4']);
  });

  it('a gap in step indices links to the closest lower step, never cutting history', () => {
    const p = feed([ln(0, 'A', 'USER_INPUT'), ln(1, 'A'), ln(3, 'A'), ln(4, 'A')]);
    expect(p.kept.map((k) => k.index)).toEqual([0, 1, 3, 4]);
  });

  it('hover line positions follow the chosen run', () => {
    const lines = [ln(0, 'A', 'USER_INPUT'), ln(1, 'A'), ln(2, 'A'), ln(1, 'B'), ln(3, 'A')];
    const p = feed(lines);
    const start = (n: number) => lines.slice(0, n).reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);
    expect(p.lines.get(1)).toEqual({ start: start(1), length: Buffer.byteLength(lines[1]!) });
    expect([...p.lines.keys()]).toEqual([0, 1, 2, 3]);
  });

  it('never counts CHECKPOINT tokens', () => {
    const s = parse('transcript-checkpoint.jsonl').summary();
    expect(s.used).toBe(205000);
    expect(s.totals.calls).toBe(1);
  });

  it('gives null used (n/a) when no planner step has counts', () => {
    expect(parse('transcript-old.jsonl').summary().used).toBeNull();
  });

  it('skips malformed complete lines', () => {
    const p = new TranscriptParser();
    p.ingest(Buffer.from('not json\n{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","input_tokens":1,"cache_read_tokens":2,"output_tokens":3}\n'));
    expect(p.summary().used).toBe(3);
  });
});

describe('readTranscript (incremental, injected io)', () => {
  function memIo(files: { data: Buffer }): FileIo {
    return {
      size: () => files.data.length,
      read: (_f, from, to) => files.data.subarray(from, to),
    };
  }

  it('reads only appended bytes and rereads when the file shrinks', () => {
    const full = fx('transcript-basic.jsonl');
    const lines = full.toString('utf8').split('\n').filter(Boolean);
    const first = Buffer.from(lines.slice(0, 2).join('\n') + '\n');
    const box = { data: first };
    const p = new TranscriptParser();
    expect(readTranscript(p, 'x', memIo(box))).toBe(true);
    expect(p.offset).toBe(first.length);
    expect(p.summary().used).toBe(4000);
    expect(readTranscript(p, 'x', memIo(box))).toBe(false);
    box.data = full;
    readTranscript(p, 'x', memIo(box));
    expect(p.summary().used).toBe(6600);
    box.data = fx('transcript-old.jsonl'); // shrinks
    readTranscript(p, 'x', memIo(box));
    expect(p.summary().used).toBeNull();
    expect(p.kept.length).toBe(2);
  });
});
