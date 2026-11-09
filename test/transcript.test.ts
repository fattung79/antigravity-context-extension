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
