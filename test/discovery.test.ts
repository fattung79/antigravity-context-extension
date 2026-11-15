import { describe, expect, it } from 'vitest';
import { parseSelection, resolveTitle, selectActive, stateDbCandidates } from '../src/discovery';

describe('resolveTitle', () => {
  it('prefers title, then preview, then first prompt + HH:mm', () => {
    expect(resolveTitle({ summaryTitle: 'T', preview: 'P', firstPrompt: 'F' })).toBe('T');
    expect(resolveTitle({ summaryTitle: ' ', preview: 'P', firstPrompt: 'F' })).toBe('P');
    expect(resolveTitle({ firstPrompt: 'Fix it', lastActivity: '2026-11-05T10:00:00Z' })).toMatch(/^Fix it \(\d\d:\d\d\)$/);
  });
  it('cuts long prompts to ~40 chars', () => {
    const t = resolveTitle({ firstPrompt: 'x'.repeat(100) });
    expect(t).toBe('x'.repeat(40) + '…');
  });
  it('has a placeholder when nothing is known', () => {
    expect(resolveTitle({})).toBe('Untitled Conversation');
  });
});

describe('selectActive', () => {
  const conversations = [
    { id: 'a', transcriptMtimeMs: 100 },
    { id: 'b', transcriptMtimeMs: 200 },
    { id: 'c', transcriptMtimeMs: 300 },
  ];
  const summaries = new Map([
    ['a', { workspaceUris: ['file:///w/me'], lastModifiedMs: 150 }],
    ['b', { workspaceUris: ['file:///w/me/'], lastModifiedMs: 250 }],
    ['c', { workspaceUris: ['file:///w/other'], lastModifiedMs: 350 }],
  ]);
  const base = { prevActiveId: null, conversations, summaries, workspaceUris: ['file:///w/me'] };

  it('uses the selected id when known', () => {
    expect(selectActive({ ...base, selectedId: 'a' })).toEqual({ id: 'a', notSelected: false });
  });
  it('keeps the previous Active as notSelected when cleared', () => {
    expect(selectActive({ ...base, selectedId: null, prevActiveId: 'a' })).toEqual({ id: 'a', notSelected: true });
  });
  it('fresh window and nothing selected: latest write in this folder, notSelected', () => {
    expect(selectActive({ ...base, selectedId: null })).toEqual({ id: 'b', notSelected: true });
  });
  it('unknown selected id behaves like nothing selected', () => {
    expect(selectActive({ ...base, selectedId: 'zzz', prevActiveId: 'a' })).toEqual({ id: 'a', notSelected: true });
  });
  it('unreadable state.vscdb falls back to newest transcript write', () => {
    expect(selectActive({ ...base, selectedId: undefined, prevActiveId: 'a' })).toEqual({ id: 'c', notSelected: false });
  });
  it('returns null with nothing to show', () => {
    expect(selectActive({ ...base, selectedId: null, conversations: [], workspaceUris: [] })).toBeNull();
  });
});

describe('selection value / state db location', () => {
  it('parses lastConversationId, nested or top-level, and cleared', () => {
    expect(parseSelection('{"lastConversationId":"x"}')).toBe('x');
    expect(parseSelection('{"a":{"lastConversationId":"y"}}')).toBe('y');
    expect(parseSelection('{}')).toBeNull();
    expect(parseSelection('garbage')).toBeNull();
  });
  it('builds candidates from the storageUri hash folder', () => {
    const c = stateDbCandidates('/data/workspaceStorage/HASH/local.ext', () => ['/mnt/c/Users/u']);
    expect(c).toEqual([
      '/data/workspaceStorage/HASH/state.vscdb',
      '/mnt/c/Users/u/AppData/Roaming/Antigravity IDE/User/workspaceStorage/HASH/state.vscdb',
    ]);
  });
});
