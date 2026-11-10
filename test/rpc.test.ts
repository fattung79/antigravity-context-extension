import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALLOWED_METHODS, RpcClient, RpcError, type HttpRequest, type Transport } from '../src/sources/rpc/client';
import type { Clock } from '../src/sources/rpc/clock';
import {
  parseCmdline, parsePpid, readProcTable, selectServer, ServerHandle, type ProcInfo,
} from '../src/sources/rpc/processTable';
import { Puller } from '../src/sources/rpc/puller';
import { Recovery, recoveryDelay } from '../src/sources/rpc/recovery';
import { buildRpcSnapshot, lastPlannerStep, parseGeneratorMetadata, parseRuleFiles, tokenBaseChildren } from '../src/sources/rpc/reply';
import { StaleGuard } from '../src/sources/rpc/staleGuard';

/** Fake clock: advance() runs due timers in order and lets promise continuations settle. */
class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.timers.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x.id !== h); }
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      await settle();
      const next = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
    await settle();
  }
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const TOKEN = '11111111-2222-3333-4444-555555555555';
const agy = (pid: number, ppid: number, extra: string[] = [], tokenForm: 'eq' | 'sep' = 'eq', port = 4000 + pid): ProcInfo => ({
  pid, ppid,
  args: [
    '/home/u/.gemini/bin/agy', '--hub', `--hub-port=${port}`, '--app_data_dir=antigravity',
    ...(tokenForm === 'eq' ? [`--csrf_token=${TOKEN}`] : ['--csrf_token', TOKEN]), ...extra,
  ],
});

describe('allowlist', () => {
  const okTransport: Transport = async () => ({ status: 200, text: '{}' });
  const server = new ServerHandle(1, 4000, TOKEN);

  it('is exactly the three read-only methods', () => {
    expect([...ALLOWED_METHODS].sort()).toEqual(['GetAllCascadeTrajectories', 'GetCascadeTrajectoryExecutorMetadatas', 'GetCascadeTrajectoryGeneratorMetadata', 'GetTokenBase']);
  });

  it.each(['GetUserStatus', 'SendUserCascadeMessage', 'CancelCascadeInvocation', 'getTokenBase', 'GetTokenBase/../X', ''])(
    'refuses %j before sending',
    async (m) => {
      let sent = 0;
      const c = new RpcClient(server, async (r) => { sent++; return okTransport(r); });
      await expect(c.call(m, {})).rejects.toMatchObject({ kind: 'forbidden' });
      expect(sent).toBe(0);
    },
  );

  it('sends allowlisted methods to loopback with the connect headers', async () => {
    let req: HttpRequest | undefined;
    const c = new RpcClient(server, async (r) => { req = r; return { status: 200, text: '{"a":1}' }; });
    expect(await c.call('GetTokenBase', {})).toEqual({ a: 1 });
    expect(req!.host).toBe('127.0.0.1');
    expect(req!.path).toBe('/exa.language_server_pb.LanguageServerService/GetTokenBase');
    expect(req!.headers['X-Codeium-Csrf-Token']).toBe(TOKEN);
    expect(req!.headers['Connect-Protocol-Version']).toBe('1');
  });

  it('maps failures to kinds without leaking the token', async () => {
    const mk = (t: Transport) => new RpcClient(server, t).call('GetTokenBase', {});
    await expect(mk(async () => ({ status: 401, text: '' }))).rejects.toMatchObject({ kind: 'auth' });
    await expect(mk(async () => ({ status: 403, text: '' }))).rejects.toMatchObject({ kind: 'auth' });
    await expect(mk(async () => ({ status: 500, text: '' }))).rejects.toMatchObject({ kind: 'http' });
    await expect(mk(async () => ({ status: 200, text: 'nope' }))).rejects.toMatchObject({ kind: 'shape' });
    const e = await mk(async () => { throw Object.assign(new Error(`boom ${TOKEN}`), { code: 'ECONNREFUSED' }); }).catch((x: RpcError) => x);
    expect((e as RpcError).kind).toBe('connection');
    expect((e as RpcError).message).not.toContain(TOKEN);
  });

  it('ServerHandle never serialises its token', () => {
    expect(JSON.stringify(server)).not.toContain(TOKEN);
    expect(String(server)).not.toContain(TOKEN);
  });
});

describe('/proc candidate selection', () => {
  const sel = (procs: ProcInfo[], folders: string[] = []) => selectServer(procs, { hostPid: 100, hostPpid: 90, workspaceFolders: folders });

  it('picks the server whose parent is the extension host', () => {
    const s = sel([agy(1, 1), agy(2, 555), agy(3, 100)]);
    expect(s?.pid).toBe(3);
  });

  it('accepts the host parent too', () => {
    expect(sel([agy(2, 555), agy(4, 90)])?.pid).toBe(4);
  });

  it('skips orphans (ppid 1) even when they match add-dir', () => {
    expect(sel([agy(5, 1, ['--add-dir=/work/a'])], ['/work/a'])).toBeNull();
  });

  it('never picks another window\'s server without a match', () => {
    expect(sel([agy(2, 555), agy(6, 777)])).toBeNull();
  });

  it('falls back to --add-dir (both forms, trailing slash tolerated)', () => {
    expect(sel([agy(7, 555, ['--add-dir=/work/a'])], ['/work/a/'])?.pid).toBe(7);
    expect(sel([agy(8, 555, ['--add-dir', '/work/b'])], ['/work/b'])?.pid).toBe(8);
    expect(sel([agy(9, 555, ['--add-dir=/other'])], ['/work/a'])).toBeNull();
  });

  it('parent match wins over add-dir', () => {
    expect(sel([agy(7, 555, ['--add-dir=/work/a']), agy(3, 100)], ['/work/a'])?.pid).toBe(3);
  });

  it('accepts --csrf_token=<v> and --csrf_token <v>', () => {
    const a = sel([agy(3, 100, [], 'eq')])!;
    const b = sel([agy(3, 100, [], 'sep')])!;
    expect(a.token()).toBe(TOKEN);
    expect(b.token()).toBe(TOKEN);
  });

  it('accepts the older --extension_server_port and antigravity-ide', () => {
    const p: ProcInfo = { pid: 3, ppid: 100, args: ['/x/agy', '--extension_server_port=4321', '--app_data_dir', 'antigravity-ide', '--csrf_token', TOKEN] };
    expect(sel([p])?.port).toBe(4321);
  });

  it('rejects other binaries, app dirs, missing token/port', () => {
    const base = agy(3, 100);
    expect(sel([{ ...base, args: ['/usr/bin/node', ...base.args.slice(1)] }])).toBeNull();
    expect(sel([{ ...base, args: base.args.map((a) => (a.startsWith('--app_data_dir') ? '--app_data_dir=other' : a)) }])).toBeNull();
    expect(sel([{ ...base, args: base.args.filter((a) => !a.startsWith('--csrf_token')) }])).toBeNull();
    expect(sel([{ ...base, args: base.args.filter((a) => !a.startsWith('--hub-port')) }])).toBeNull();
  });

  it('prefers the newest of several parent matches', () => {
    expect(sel([agy(3, 100), agy(8, 100)])?.pid).toBe(8);
  });

  it('parses cmdline and stat, and never touches environ', () => {
    expect(parseCmdline('a\0--b=c\0')).toEqual(['a', '--b=c']);
    expect(parsePpid('12 (agy (x) y) S 34 1 2')).toBe(34);
    const reads: string[] = [];
    const files: Record<string, string> = {
      '/proc/10/cmdline': `/x/agy\0--csrf_token=${TOKEN}\0`,
      '/proc/10/stat': '10 (agy) S 7 1 1',
      '/proc/11/cmdline': 'bash\0',
    };
    const t = readProcTable({
      readdir: () => ['10', '11', 'self', 'cpuinfo'],
      readFile: (f) => { reads.push(f); const v = files[f]; if (v === undefined) throw new Error('ENOENT'); return v; },
    });
    expect(t.list()).toEqual([{ pid: 10, ppid: 7, args: ['/x/agy', `--csrf_token=${TOKEN}`] }]);
    expect(reads.some((r) => r.includes('environ'))).toBe(false);
  });
});

describe('reply -> Snapshot', () => {
  const reply = JSON.parse(readFileSync(new URL('./fixtures/generator-metadata-reply.json', import.meta.url), 'utf8'));

  it('skips a trailing call whose usage has no token counts (aborted call, real data 16c7dd2b)', () => {
    const r = structuredClone(reply);
    const tail = structuredClone(r.generatorMetadata[r.generatorMetadata.length - 1]);
    tail.chatModel.usage = { outputTokens: '5' };
    r.generatorMetadata.push(tail);
    const m = parseGeneratorMetadata(r)!;
    expect(m.used).toBe(14000);
  });

  it('extracts used, model, limit, estimate, breakdown, totals from the last usable entry', () => {
    const m = parseGeneratorMetadata(reply)!;
    expect(m.used).toBe(14000); // 2000 input + 12000 cache read (last call WITH usage)
    expect(m.input).toBe(2000);
    expect(m.cacheRead).toBe(12000);
    expect(m.modelDisplay).toBe('Gemini 3.8 Flash (Medium)');
    expect(m.maxContextTokens).toBe(256000);
    expect(m.estimate).toBe(19056);
    expect(m.startStepIndex).toBe(0);
    expect(m.truncationReason).toBe('TRUNCATION_REASON_MAX_TOKEN_LIMIT');
    expect(m.totals).toEqual({ input: 15636, cacheRead: 12000, output: 180, calls: 2 }); // cold call: no cacheReadTokens => 0
    expect(m.lastStepIndex).toBe(5);
    expect(m.breakdown.map((g) => g.name)).toEqual(['System Prompt', 'Tools', 'Chat Messages']);
  });

  it('builds a rpc Snapshot with labels joined from the transcript', () => {
    const m = parseGeneratorMetadata(reply)!;
    const steps = [
      { index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', contentLength: 40, promptPreview: 'Fix the bug please' },
      { index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', contentLength: 10, tokens: { input: 1, cacheRead: 0, output: 1 } },
      { index: 2, source: 'MODEL', type: 'GENERIC', contentLength: 100 },
    ];
    const s = buildRpcSnapshot(m, {
      conversationId: 'abc', title: 'T', steps, limitOverrides: {}, limitDefault: null, heavyPercent: 5, notSelected: false, role: 'active',
    });
    expect(s.source).toBe('rpc');
    expect(s.used).toBe(14000);
    expect(s.limit).toBe(256000);
    expect(s.limitSource).toBe('server');
    expect(s.modelKey).toBe('Gemini 3.8 Flash');
    expect(s.estimate).toBe(19056);
    expect(s.startStepIndex).toBe(0);
    expect(s.truncationReason).toBe('TRUNCATION_REASON_MAX_TOKEN_LIMIT');
    expect(s.groups.map((g) => [g.name, g.tokens])).toEqual([['System Prompt', 300], ['Tools', 150], ['Chat Messages', 600]]);
    expect(s.groups[0]!.children.map((c) => c.label)).toEqual(['identity', 'user_rules']);
    const chat = s.groups[2]!;
    expect(chat.children.reduce((a, c) => a + c.tokens, 0)).toBe(600);
    expect(chat.children.some((c) => c.step === 0)).toBe(true);
  });

  it('override beats the server limit', () => {
    const m = parseGeneratorMetadata(reply)!;
    const s = buildRpcSnapshot(m, { conversationId: 'a', title: 't', steps: [], limitOverrides: { 'Gemini 3.8 Flash': 100000 }, limitDefault: null, heavyPercent: 5, notSelected: false, role: 'active' });
    expect(s.limit).toBe(100000);
    expect(s.limitSource).toBe('override');
  });

  it('records model changes between calls', () => {
    const r = JSON.parse(JSON.stringify(reply));
    r.generatorMetadata[1].chatModel.modelDisplayName = 'Other Model (High)';
    expect(parseGeneratorMetadata(r)!.modelChanges).toEqual([{ step: 3, from: 'Gemini 3.8 Flash (Medium)', to: 'Other Model (High)' }]);
  });

  it('returns null when there is nothing usable (empty / in-flight only)', () => {
    expect(parseGeneratorMetadata({})).toBeNull();
    expect(parseGeneratorMetadata({ generatorMetadata: [] })).toBeNull();
    expect(parseGeneratorMetadata({ generatorMetadata: [reply.generatorMetadata[2]] })).toBeNull();
  });

  it.each([
    ['not an object', 'x'],
    ['array', []],
    ['generatorMetadata not array', { generatorMetadata: {} }],
    ['entry not object', { generatorMetadata: [1] }],
    ['usage not object', { generatorMetadata: [{ chatModel: { usage: 'x' } }] }],
    ['non-numeric tokens', { generatorMetadata: [{ chatModel: { usage: { inputTokens: 'abc' } } }] }],
    ['bad breakdown group', { generatorMetadata: [{ chatModel: { usage: { inputTokens: '1' }, chatStartMetadata: { contextWindowMetadata: { tokenBreakdown: { groups: [{ numTokens: 1 }] } } } } }] }],
  ])('shape gate: %s throws', (_n, bad) => {
    expect(() => parseGeneratorMetadata(bad)).toThrowError(RpcError);
  });

  it('lastPlannerStep = last step with usage', () => {
    expect(lastPlannerStep([{ index: 1, source: '', type: '', contentLength: 0, tokens: { input: 1, cacheRead: 0, output: 0 } }, { index: 2, source: '', type: '', contentLength: 0 }])).toBe(1);
    expect(lastPlannerStep([])).toBeNull();
  });

  it('GetTokenBase children shown only when they sum to the section total', () => {
    const kids = [{ name: 'a', tokens: 60 }, { name: 'b', tokens: 40 }];
    expect(tokenBaseChildren(100, kids)).toEqual(kids);
    expect(tokenBaseChildren(120, kids)).toBeNull();
    expect(tokenBaseChildren(0, [])).toBeNull();
  });
});

describe('lastExecutionId', () => {
  it('is the executionId of the last entry that has one, else null', () => {
    const reply = JSON.parse(readFileSync(new URL('./fixtures/generator-metadata-reply.json', import.meta.url), 'utf8'));
    expect(parseGeneratorMetadata(structuredClone(reply))!.lastExecutionId).toBe('00000000-0000-0000-0000-000000000003');
    const r = structuredClone(reply);
    delete r.generatorMetadata[r.generatorMetadata.length - 1].executionId;
    expect(parseGeneratorMetadata(r)!.lastExecutionId).toBe('00000000-0000-0000-0000-000000000002');
    for (const e of r.generatorMetadata) delete e.executionId;
    expect(parseGeneratorMetadata(r)!.lastExecutionId).toBeNull();
  });
});

describe('parseRuleFiles', () => {
  const R = 'REFRESH_CUSTOMIZATION_TYPE_RULE';
  const mk = (...customizations: unknown[]) => ({ executorMetadata: [{ loadedCustomizations: { customizations } }] });
  const rule = (path: unknown, extra: Record<string, unknown> = {}) => ({ type: R, path, scope: 'SCOPE_WORKSPACE', status: 'STATUS_ENABLED', ...extra });

  it('keeps enabled absolute RULE files with lower-cased scope', () => {
    const r = parseRuleFiles(mk(
      rule('/home/u/proj/AGENTS.md'),
      rule('/home/u/.gemini/AGENTS.md', { scope: 'SCOPE_GLOBAL' }),
      { type: 'REFRESH_CUSTOMIZATION_TYPE_SKILL', name: 'x', path: '/a/SKILL.md', scope: 'SCOPE_BUILTIN', status: 'STATUS_ENABLED' },
      { type: 'REFRESH_CUSTOMIZATION_TYPE_AGENT', name: 'research', scope: 'SCOPE_BUILTIN', status: 'STATUS_ENABLED' },
    ));
    expect(r).toEqual([
      { path: '/home/u/proj/AGENTS.md', scope: 'workspace' },
      { path: '/home/u/.gemini/AGENTS.md', scope: 'global' },
    ]);
  });
  it('skips disabled and non-absolute, dedupes by path', () => {
    expect(parseRuleFiles(mk(
      rule('/a/x.md', { status: 'STATUS_DISABLED' }), rule('rel/x.md'), rule(5), rule('/a/y.md'), rule('/a/y.md'),
    ))).toEqual([{ path: '/a/y.md', scope: 'workspace' }]);
  });
  it('uses the last entry that has loadedCustomizations', () => {
    const r = { executorMetadata: [
      { loadedCustomizations: { customizations: [rule('/old.md')] } },
      { loadedCustomizations: { customizations: [rule('/new.md')] } },
      { executionId: 'x' },
    ] };
    expect(parseRuleFiles(r)).toEqual([{ path: '/new.md', scope: 'workspace' }]);
  });
  it('null for unusable shapes, [] when no rules', () => {
    for (const v of [{}, null, 'x', 5, { executorMetadata: 'x' }, { executorMetadata: [{}] }, { executorMetadata: [{ loadedCustomizations: { customizations: 'x' } }] }]) {
      expect(parseRuleFiles(v)).toBeNull();
    }
    expect(parseRuleFiles(mk())).toEqual([]);
  });
});

describe('recovery backoff schedule', () => {
  it('delays are 5/15/30/60 s then 60 s', () => {
    expect([0, 1, 2, 3, 4, 9].map(recoveryDelay)).toEqual([5000, 15000, 30000, 60000, 60000, 60000]);
  });

  it('retries on the schedule and switches back on success', async () => {
    const clock = new FakeClock();
    const calls: number[] = [];
    let ok = false;
    let recovered = 0;
    const r = new Recovery(clock, () => { calls.push(clock.t); return ok; }, () => { recovered++; });
    r.start();
    await clock.advance(200_000);
    expect(calls).toEqual([5000, 20000, 50000, 110000, 170000]);
    ok = true;
    await clock.advance(60_000);
    expect(calls.at(-1)).toBe(230000);
    expect(recovered).toBe(1);
    expect(r.running).toBe(false);
    await clock.advance(200_000);
    expect(calls.length).toBe(6); // stopped
  });

  it('manual retry looks up immediately and restarts the schedule', async () => {
    const clock = new FakeClock();
    const calls: number[] = [];
    const r = new Recovery(clock, () => { calls.push(clock.t); return false; }, () => undefined);
    r.start();
    await clock.advance(5000 + 15000 + 1000);
    r.retryNow();
    expect(calls).toEqual([5000, 20000, 21000]);
    await clock.advance(5000);
    expect(calls).toEqual([5000, 20000, 21000, 26000]);
  });
});

describe('stale-server guard', () => {
  it('needs 2 consecutive trailing checks', () => {
    const g = new StaleGuard();
    expect(g.check(10, 12)).toBe(false);
    expect(g.check(10, 12)).toBe(true);
  });
  it('resets when the server catches up', () => {
    const g = new StaleGuard();
    expect(g.check(10, 12)).toBe(false);
    expect(g.check(12, 12)).toBe(false);
    expect(g.check(10, 12)).toBe(false);
  });
  it('is quiet when the transcript has no planner step; trailing when server reports none', () => {
    const g = new StaleGuard();
    expect(g.check(null, null)).toBe(false);
    expect(g.check(null, null)).toBe(false);
    expect(g.check(null, 3)).toBe(false);
    expect(g.check(null, 3)).toBe(true);
  });
  it('server ahead of the transcript is fine', () => {
    const g = new StaleGuard();
    expect(g.check(20, 12)).toBe(false);
    expect(g.check(20, 12)).toBe(false);
  });
});

describe('pull-on-change scheduling', () => {
  function setup(durations: number[] | (() => number)) {
    const clock = new FakeClock();
    const starts: number[] = [];
    let i = 0;
    const dur = () => (typeof durations === 'function' ? durations() : durations[Math.min(i, durations.length - 1)]!);
    const p = new Puller({
      clock,
      fetch: async () => { starts.push(clock.t); const d = dur(); i++; await new Promise<void>((res) => clock.setTimeout(res, d)); },
    });
    return { clock, starts, p };
  }

  it('waits 500 ms after the last change (settle)', async () => {
    const { clock, starts, p } = setup([10]);
    p.notifyChange('a');
    await clock.advance(300);
    p.notifyChange('a'); // activity restarts the settle wait
    await clock.advance(400);
    expect(starts).toEqual([]);
    await clock.advance(100);
    expect(starts).toEqual([800]);
  });

  it('never has two calls in flight; one follow-up for changes during a call', async () => {
    const { clock, starts, p } = setup([1000]);
    p.notifyChange('a');
    await clock.advance(500); // call starts at 500, ends at 1500
    p.notifyChange('a');
    p.notifyChange('a');
    p.notifyChange('a');
    await clock.advance(200);
    expect(starts).toEqual([500]);
    await clock.advance(5000);
    expect(starts).toEqual([500, 1500]); // exactly one follow-up
  });

  it('independent Conversations do not block each other', async () => {
    const { clock, starts, p } = setup([1000]);
    p.notifyChange('a');
    p.notifyChange('b');
    await clock.advance(500);
    expect(starts).toEqual([500, 500]);
  });

  it('a reply over 2 s backs off to one call per 10 s', async () => {
    const { clock, starts, p } = setup([2500, 100]);
    p.notifyChange('a');
    await clock.advance(500); // starts 500, ends 3000 (slow)
    p.notifyChange('a');
    await clock.advance(2600); // t=3100: change arrived during/after, but backed off
    expect(starts).toEqual([500]);
    await clock.advance(7000); // t=10100: >= 500 + 10000? not yet (10500)
    expect(starts).toEqual([500]);
    await clock.advance(500);
    expect(starts).toEqual([500, 10500]);
  });

  it('a fast reply clears the back-off', async () => {
    const { clock, starts, p } = setup([2500, 100, 100]);
    p.notifyChange('a');
    await clock.advance(500);
    await clock.advance(10_000); // 10500: the second call starts only if a change came
    p.notifyChange('a', true);
    await clock.advance(0);
    expect(starts.length).toBe(2);
    await clock.advance(200);
    p.notifyChange('a');
    await clock.advance(500);
    expect(starts.length).toBe(3); // no back-off after a fast reply
  });

  it('manual refresh (immediate) skips settle and back-off', async () => {
    const { clock, starts, p } = setup([2500, 100]);
    p.notifyChange('a');
    await clock.advance(3000);
    p.notifyChange('a', true);
    await clock.advance(0);
    expect(starts).toEqual([500, 3000]);
  });

  it('fetch errors do not stop later pulls', async () => {
    const clock = new FakeClock();
    let n = 0;
    const errs: string[] = [];
    const p = new Puller({ clock, fetch: async () => { n++; throw new Error('x'); }, onError: (id) => errs.push(id) });
    p.notifyChange('a');
    await clock.advance(600);
    p.notifyChange('a');
    await clock.advance(600);
    expect(n).toBe(2);
    expect(errs).toEqual(['a', 'a']);
  });

  it('dispose cancels pending timers', async () => {
    const { clock, starts, p } = setup([10]);
    p.notifyChange('a');
    p.dispose();
    await clock.advance(2000);
    expect(starts).toEqual([]);
  });
});
