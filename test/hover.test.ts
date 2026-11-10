import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLineAt, readTranscript } from '../src/sources/file';
import { TranscriptParser } from '../src/sources/transcript';
import { buildChatHover, buildMetaHover, cutHeadTail, fence, maskSecrets } from '../src/ui/hover';

const TOKEN = '11111111-2222-3333-4444-555555555555';

describe('cutHeadTail', () => {
  it('leaves short text untouched', () => {
    expect(cutHeadTail('hello', 2000)).toBe('hello');
    expect(cutHeadTail('x'.repeat(2000), 2000)).toBe('x'.repeat(2000));
  });
  it('keeps 1500 head + 500 tail with a gap marker', () => {
    const t = 'a'.repeat(1500) + 'M'.repeat(1000) + 'z'.repeat(500);
    const out = cutHeadTail(t, 2000);
    expect(out).toBe('a'.repeat(1500) + '\n… 1000 chars omitted …\n' + 'z'.repeat(500));
  });
});

describe('thinking budget', () => {
  const base = { label: '#1 Model reply', step: 1, hoverChars: 2000 };
  it('shows head only, up to 1000 chars, in its own section', () => {
    const out = buildChatHover({ ...base, line: { type: 'PLANNER_RESPONSE', content: 'reply', thinking: 't'.repeat(900) + 'H'.repeat(1100) } });
    expect(out).toContain('**Thinking** (~667 tok)');
    expect(out).toContain('t'.repeat(900) + 'H'.repeat(100) + '\n… 1000 chars omitted …');
    expect(out).not.toContain('H'.repeat(101));
    expect(out).toContain('**Reply**');
  });
  it('leaves short thinking untouched', () => {
    const out = buildChatHover({ ...base, line: { type: 'PLANNER_RESPONSE', content: 'r', thinking: 'short' } });
    expect(out).toContain('short');
    expect(out).not.toContain('omitted');
  });
});

describe('masking', () => {
  it('masks the exact live token and token-shaped csrf values', () => {
    expect(maskSecrets(`x ${TOKEN} y`, TOKEN)).toBe('x ‹csrf› y');
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(maskSecrets(`--csrf_token=${other} ok`)).toBe('--csrf_token=‹csrf› ok');
    expect(maskSecrets('plain a@b.com stays')).toBe('plain a@b.com stays');
  });
  it('masks inside tool calls and results, call before result', () => {
    const out = buildChatHover({
      label: '#1 run_command', step: 1, call: 0, resultStep: 2, hoverChars: 2000, token: TOKEN,
      line: { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: `curl -H ${TOKEN}` } }] },
      resultLine: { type: 'GENERIC', content: `got ${TOKEN}` },
    });
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('‹csrf›');
    expect(out.indexOf('Call run\\_command')).toBeGreaterThan(-1);
    expect(out.indexOf('Call run\\_command')).toBeLessThan(out.indexOf('**Result**'));
  });
});

describe('fence', () => {
  it('uses a longer fence than any backtick run in the text', () => {
    const out = fence('a ```` b\n```');
    expect(out.startsWith('`````\n')).toBe(true);
    expect(out.endsWith('\n`````')).toBe(true);
  });
  it('defaults to three backticks', () => {
    expect(fence('x')).toBe('```\nx\n```');
  });
});

describe('metadata-only and missing', () => {
  it('shows name, count, source only', () => {
    const out = buildMetaHover({ name: 'user_information', count: '1.2k', source: 'rpc' });
    expect(out).toContain('Tokens: 1\\.2k'.replace('\\.', '.'));
    expect(out).toContain('Source: rpc');
  });
  it('reports unavailable text when the step is missing', () => {
    expect(buildChatHover({ label: '#9 x', step: 9, line: null, hoverChars: 2000 })).toContain('text unavailable');
  });
});

describe('offset-based line lookup', () => {
  it('reads exactly the recorded bytes, incl. multibyte and after rewind', () => {
    const lines = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>héllo ✓</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'one' },
      { step_index: 2, type: 'GENERIC', content: 'two' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'rewound' },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'hover-'));
    const file = join(dir, 't.jsonl');
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const parser = new TranscriptParser();
    readTranscript(parser, file);
    expect(readLineAt(file, parser.lines.get(0)!)?.content).toContain('héllo ✓');
    expect(readLineAt(file, parser.lines.get(1)!)?.content).toBe('rewound');
    expect(parser.lines.has(2)).toBe(false);
  });
  it('tracks offsets across incremental ingests', () => {
    const a = Buffer.from(JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'é' }) + '\n');
    const b = Buffer.from(JSON.stringify({ step_index: 1, type: 'GENERIC', content: 'x' }) + '\n');
    const p = new TranscriptParser();
    p.ingest(a);
    p.ingest(b);
    expect(p.lines.get(1)).toEqual({ start: a.length, length: b.length - 1 });
  });
});
