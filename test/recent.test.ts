import { describe, expect, it } from 'vitest';
import { Store, type Snapshot } from '../src/model';
import { AnnotationReader, countdownText, parseAnnotation, rankRecent } from '../src/recent';
import type { Clock } from '../src/sources/rpc/clock';
import { cutTitle, formatActiveLabelMulti, formatRecentLabel, formatTooltip } from '../src/ui/statusBarFormat';
import { buildConversationDescription } from '../src/ui/treeModel';

class FakeClock implements Clock {
  t = 1_000_000;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private next = 1;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = this.next++; this.timers.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x.id !== h); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

function snap(id: string, role: Snapshot['role'] = 'recent', over: Partial<Snapshot> = {}): Snapshot {
  return {
    conversationId: id, title: `Title ${id}`, source: 'file', used: 41000, limit: 100000, limitSource: 'x',
    modelKey: null, modelDisplay: null, estimate: null, groups: [],
    totals: { input: 0, cacheRead: 0, output: 0, calls: 0 }, compaction: null, modelChanges: [], startStepIndex: null,
    notSelected: false, role, ...over,
  };
}

describe('parseAnnotation', () => {
  it('seconds + nanos', () => {
    expect(parseAnnotation('last_user_view_time:{seconds:1793165308 nanos:909000000}')).toBe(1793165308909);
  });
  it('seconds only, whitespace, trailing content', () => {
    expect(parseAnnotation('foo: 1\nlast_user_view_time: { seconds: 10 }\nbar: 2')).toBe(10000);
  });
  it('missing or malformed => null', () => {
    expect(parseAnnotation('')).toBeNull();
    expect(parseAnnotation('last_user_view_time:{nanos:5}')).toBeNull();
    expect(parseAnnotation('other:{seconds:1}')).toBeNull();
  });
});

describe('AnnotationReader', () => {
  it('re-reads only files whose mtime changed', () => {
    const files: Record<string, { m: number; text: string }> = {
      '/r/annotations/a.pbtxt': { m: 1, text: 'last_user_view_time:{seconds:100 nanos:0}' },
      '/r/annotations/b.pbtxt': { m: 1, text: 'last_user_view_time:{seconds:200 nanos:0}' },
      '/r/annotations/readme.txt': { m: 1, text: '' },
    };
    const r = new AnnotationReader({
      list: () => Object.keys(files).map((f) => f.split('/').pop()!),
      mtimeMs: (f) => files[f]?.m ?? null,
      read: (f) => files[f]!.text,
    });
    expect([...r.scan(['/r'])]).toEqual([['a', 100000], ['b', 200000]]);
    expect(r.lastReads).toBe(2);
    r.scan(['/r']);
    expect(r.lastReads).toBe(0);
    files['/r/annotations/a.pbtxt'] = { m: 2, text: 'last_user_view_time:{seconds:300 nanos:0}' };
    expect(r.scan(['/r']).get('a')).toBe(300000);
    expect(r.lastReads).toBe(1);
  });
});

describe('rankRecent', () => {
  it('rank key is the later of view and write; newest first', () => {
    const out = rankRecent([
      { id: 'a', viewMs: 100, writtenMs: 500 },
      { id: 'b', viewMs: 600, writtenMs: 50 },
      { id: 'c', viewMs: 300 },
    ], null, 4);
    expect(out.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(out[0]!.rankMs).toBe(600);
  });
  it('ties break by id', () => {
    const out = rankRecent([{ id: 'z', viewMs: 5 }, { id: 'a', viewMs: 5 }, { id: 'm', writtenMs: 5 }], null, 9);
    expect(out.map((x) => x.id)).toEqual(['a', 'm', 'z']);
  });
  it('excludes the Active Conversation', () => {
    const out = rankRecent([{ id: 'a', viewMs: 9 }, { id: 'b', viewMs: 1 }], 'a', 3);
    expect(out.map((x) => x.id)).toEqual(['b']);
  });
  it('caps at maxConversations - 1', () => {
    const c = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, viewMs: n }));
    expect(rankRecent(c, null, 3).map((x) => x.id)).toEqual(['c4', 'c3']);
    expect(rankRecent(c, 'c4', 3).map((x) => x.id)).toEqual(['c3', 'c2']);
    expect(rankRecent(c, null, 1)).toEqual([]);
  });
  it('drops candidates with no timestamp at all', () => {
    expect(rankRecent([{ id: 'a' }], null, 3)).toEqual([]);
  });
});

describe('countdownText', () => {
  it('minutes, then <1m', () => {
    expect(countdownText(180_000)).toBe('drops in 3m');
    expect(countdownText(150_000)).toBe('drops in 3m');
    expect(countdownText(120_000)).toBe('drops in 2m');
    expect(countdownText(61_000)).toBe('drops in 2m');
    expect(countdownText(60_000)).toBe('drops in <1m');
    expect(countdownText(1)).toBe('drops in <1m');
    expect(countdownText(0)).toBe('drops in <1m');
  });
  it('shown in tree description and tooltip', () => {
    const s = snap('a', 'recent', { expiresAt: 1_000_000 + 120_000 });
    expect(buildConversationDescription(s, 1_000_000)).toContain('· drops in 2m');
    expect(formatTooltip(s, false, null, 1_000_000 + 100_000)).toContain('drops in \\<1m');
    expect(buildConversationDescription(snap('b', 'active'), 1_000_000)).not.toContain('drops');
  });
});

describe('status bar labels', () => {
  it('cuts at a word break with an ellipsis', () => {
    expect(cutTitle('Refactor the auth module')).toBe('Refactor…');
    expect(cutTitle('Fix WSL path bug')).toBe('Fix WSL…');
    expect(cutTitle('Can you help me')).toBe('Can you…');
  });
  it('short titles are untouched; a long single word is hard-cut', () => {
    expect(cutTitle('Short')).toBe('Short');
    expect(cutTitle('1234567890')).toBe('1234567890');
    expect(cutTitle('Supercalifragilistic')).toBe('Supercalif…');
  });
  it('Recent shows glyph + percentage only; Active keeps numbers', () => {
    expect(formatRecentLabel({ title: 'Refactor the auth module', used: 41000, limit: 100000, source: 'rpc' })).toBe('◷ Refactor… 41%');
    expect(formatActiveLabelMulti({ title: 'Fix WSL path bug', used: 159000, limit: 256000, source: 'rpc' })).toBe('◔ Fix WSL… 62% · 159k/256k');
  });
});

describe('Store Recent expiry', () => {
  const MIN = 60_000;
  it('drops a Recent after the expiry and removes its snapshot', () => {
    const clock = new FakeClock();
    const store = new Store(clock);
    store.syncRecent([{ id: 'r1', rankMs: 5 }], 'act', 3 * MIN);
    store.setRecent(snap('r1'));
    expect(store.get().snapshots[0]!.expiresAt).toBe(clock.now() + 3 * MIN);
    clock.advance(3 * MIN - 1);
    expect(store.get().snapshots.map((s) => s.conversationId)).toEqual(['r1']);
    clock.advance(1);
    expect(store.get().snapshots).toEqual([]);
    expect(store.recentIds()).toEqual([]);
  });
  it('an expired Conversation stays out until its rank key moves', () => {
    const clock = new FakeClock();
    const store = new Store(clock);
    store.syncRecent([{ id: 'r1', rankMs: 5 }], 'act', MIN);
    clock.advance(MIN);
    store.syncRecent([{ id: 'r1', rankMs: 5 }], 'act', MIN);
    expect(store.recentIds()).toEqual([]);
    store.syncRecent([{ id: 'r1', rankMs: 6 }], 'act', MIN);
    expect(store.recentIds()).toEqual(['r1']);
  });
  it('re-syncing does not reset the timer; leaving the list cancels it', () => {
    const clock = new FakeClock();
    const store = new Store(clock);
    store.syncRecent([{ id: 'r1', rankMs: 5 }], null, 3 * MIN);
    clock.advance(2 * MIN);
    store.syncRecent([{ id: 'r1', rankMs: 5 }], null, 3 * MIN);
    store.setRecent(snap('r1'));
    expect(store.get().snapshots[0]!.expiresAt).toBe(1_000_000 + 3 * MIN);
    clock.advance(MIN);
    expect(store.recentIds()).toEqual([]);
  });
  it('becoming Active cancels the timer and the Recent snapshot', () => {
    const clock = new FakeClock();
    const store = new Store(clock);
    store.syncRecent([{ id: 'r1', rankMs: 5 }], 'act', MIN);
    store.setRecent(snap('r1'));
    store.setActive(snap('r1', 'active'));
    expect(store.get().snapshots.map((s) => [s.conversationId, s.role])).toEqual([['r1', 'active']]);
    store.syncRecent([], 'r1', MIN);
    clock.advance(10 * MIN);
    expect(store.get().snapshots.map((s) => s.conversationId)).toEqual(['r1']); // not dropped by the old timer
  });
  it('Active first, Recent in rank order; setRecent ignores untracked ids', () => {
    const store = new Store(new FakeClock());
    store.syncRecent([{ id: 'b', rankMs: 9 }, { id: 'a', rankMs: 8 }], 'x', MIN);
    store.setRecent(snap('a'));
    store.setRecent(snap('b'));
    store.setRecent(snap('zzz'));
    store.setActive(snap('x', 'active'));
    expect(store.get().snapshots.map((s) => s.conversationId)).toEqual(['x', 'b', 'a']);
  });
  it('redraws every 15 s while Recent are listed', () => {
    const clock = new FakeClock();
    const store = new Store(clock);
    let n = 0;
    store.onChange(() => { n++; });
    store.syncRecent([{ id: 'r1', rankMs: 5 }], null, 3 * MIN);
    const base = n;
    clock.advance(45_000);
    expect(n - base).toBe(3);
  });
});
