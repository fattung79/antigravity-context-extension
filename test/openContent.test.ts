import { describe, expect, it } from 'vitest';
import {
  buildSectionDocument, buildStepDocument, buildToolDocument, decodeContentRef, encodeContentRef,
  isForbiddenSection, type ContentRef,
} from '../src/ui/openContent';

// --- synthetic protobuf encoder
const varint = (n: number): number[] => {
  const o: number[] = [];
  let v = n;
  while (v > 127) { o.push((v & 127) | 128); v = Math.floor(v / 128); }
  o.push(v);
  return o;
};
const ld = (num: number, payload: Uint8Array | string): number[] => {
  const b = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return [...varint(num * 8 + 2), ...varint(b.length), ...b];
};
const msg = (...parts: number[][]) => new Uint8Array(parts.flat());
const section = (name: string, text: string) => ld(16, msg(ld(1, name), ld(2, text)));
const tool = (name: string, desc: string, schema: string) => ld(8, msg(ld(1, name), ld(2, desc), ld(3, schema)));
const blob = (...inner: number[][]) => msg(ld(1, msg(...inner)));

const TOKEN = '11111111-2222-3333-4444-555555555555';
const SECRET = 'SECRET-ACCOUNT-BODY';

const fixture = blob(
  section('identity', 'You are an agent. contact me@example.com'),
  section('user_rules', `rule one csrf_token=${TOKEN} and ${TOKEN}`),
  section('user_information', `<user_information>${SECRET}</user_information>`),
  section('skills', `skills text\n<user_information>${SECRET}</user_information>\nafter`),
  tool('run_command', 'Runs a command. account_name: "Bob"', '{"type":"object"}'),
);

describe('buildStepDocument', () => {
  it('renders full user request without cut-off', () => {
    const long = 'x'.repeat(10000);
    const out = buildStepDocument({ label: '#1 hi', line: { type: 'USER_INPUT', content: `<USER_REQUEST>${long}</USER_REQUEST>` } });
    expect(out).toContain('## User request');
    expect(out).toContain(long);
    expect(out).not.toContain('omitted');
  });
  it('renders thinking, reply, tool call args and result as sections', () => {
    const out = buildStepDocument({
      label: '#5 run_command ls',
      line: { type: 'PLANNER_RESPONSE', thinking: 'T'.repeat(5000), content: 'reply', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] },
      resultLine: { type: 'GENERIC', content: 'R'.repeat(6000) },
      call: 0, resultStep: 6,
    });
    for (const h of ['## Thinking', '## Model reply', '## Tool call: run_command', '## Tool result']) expect(out).toContain(h);
    expect(out).toContain('T'.repeat(5000));
    expect(out).toContain('R'.repeat(6000));
    expect(out).toContain('"CommandLine": "ls"');
  });
  it('masks the csrf token and token shape', () => {
    const out = buildStepDocument({ label: 'x', token: TOKEN, line: { type: 'GENERIC', content: `a ${TOKEN} b csrf_token=22222222-2222-3333-4444-555555555555` } });
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('22222222-2222');
  });
  it('fences cannot be closed from inside', () => {
    const out = buildStepDocument({ label: 'x', line: { type: 'GENERIC', content: 'a\n```\nb' } });
    expect(out).toContain('````');
  });
  it('missing step => friendly one-liner', () => {
    expect(buildStepDocument({ label: 'x', line: null })).toContain('Text unavailable');
  });
});

describe('buildSectionDocument / buildToolDocument', () => {
  it('maps breakdown name to its section text', () => {
    const out = buildSectionDocument({ blob: fixture, name: 'identity' });
    expect(out).toContain('You are an agent.');
    expect(out).not.toContain('user_rules');
  });
  it('masks tokens, emails and is case-insensitive on names', () => {
    const out = buildSectionDocument({ blob: fixture, name: 'USER_RULES', token: TOKEN });
    expect(out).not.toContain(TOKEN);
    expect(buildSectionDocument({ blob: fixture, name: 'identity' })).not.toContain('me@example.com');
  });
  it('strips an embedded user_information block from other sections', () => {
    const out = buildSectionDocument({ blob: fixture, name: 'skills' });
    expect(out).toContain('skills text');
    expect(out).toContain('after');
    expect(out).not.toContain(SECRET);
  });
  it('tool document has description, parameters, masked account fields', () => {
    const out = buildToolDocument({ blob: fixture, name: 'run_command' });
    expect(out).toContain('# run_command');
    expect(out).toContain('Runs a command.');
    expect(out).toContain('{"type":"object"}');
    expect(out).not.toContain('Bob');
  });
  it('unknown name / null blob / garbage blob => one-line friendly document', () => {
    for (const d of [
      buildSectionDocument({ blob: fixture, name: 'nope' }),
      buildSectionDocument({ blob: null, name: 'identity' }),
      buildToolDocument({ blob: new Uint8Array([0xff, 0xff, 0xff]), name: 'run_command' }),
    ]) {
      expect(d).toContain('Text unavailable');
      expect(d.trim().split('\n').filter((l) => l && !l.startsWith('#'))).toHaveLength(1);
    }
  });
});

describe('user_information is never shown', () => {
  it('refuses a direct request', () => {
    const out = buildSectionDocument({ blob: fixture, name: 'user_information' });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('never shown');
  });
  it('refuses aliased spellings', () => {
    for (const n of ['User_Information', ' user-information ', '<user_information>', 'USERINFORMATION', 'user information']) {
      expect(isForbiddenSection(n)).toBe(true);
      const out = buildSectionDocument({ blob: fixture, name: n });
      expect(out).not.toContain(SECRET);
      expect(out).toContain('never shown');
    }
  });
  it('refuses even with a null blob and never leaks via a differently named lookup', () => {
    expect(buildSectionDocument({ blob: null, name: 'user_information' })).toContain('never shown');
    // alias lookup resolving to the forbidden entry (normalised match) is re-checked after resolution
    const aliased = blob(section('User Information', SECRET));
    expect(buildSectionDocument({ blob: aliased, name: 'user_information' })).not.toContain(SECRET);
    const sneaky = blob(section('misc', `<user_information>${SECRET}`));
    expect(buildSectionDocument({ blob: sneaky, name: 'misc' })).not.toContain(SECRET);
  });
});

describe('content URI codec', () => {
  const refs: ContentRef[] = [
    { conversationId: 'abc-123', kind: 'step', step: 42, call: 1, resultStep: 43 },
    { conversationId: 'abc-123', kind: 'step', step: 7 },
    { conversationId: 'abc-123', kind: 'section', name: 'user_rules' },
    { conversationId: 'abc-123', kind: 'tool', name: 'weird name/with&chars=1?#' },
  ];
  it('round-trips', () => {
    for (const r of refs) {
      const e = encodeContentRef(r);
      expect(e.path.endsWith('.md')).toBe(true);
      expect(decodeContentRef(e)).toEqual(expect.objectContaining(r));
    }
  });
  it('rejects malformed', () => {
    expect(decodeContentRef({ path: '/x.md', query: '' })).toBeNull();
    expect(decodeContentRef({ path: '/x.md', query: 'c=a&k=step&s=abc' })).toBeNull();
    expect(decodeContentRef({ path: '/x.md', query: 'c=a&k=other' })).toBeNull();
  });
});
