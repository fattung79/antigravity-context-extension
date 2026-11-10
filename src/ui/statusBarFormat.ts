import type { Snapshot } from '../model';
import { countdownText } from '../recent';
import type { Level, Threshold } from './classify';

export function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k).toString() : String(Math.round(k * 10) / 10)) + 'k';
  }
  return String(n);
}

export const EMPTY_LABEL = '◌ ctx —';
export const EMPTY_TOOLTIP = 'No Conversation yet';

/** Figures part of the label: `62% · 159k/256k~`, `124k / ?~`, `n/a`. */
function figures(s: Pick<Snapshot, 'used' | 'limit' | 'source'>): string {
  const tilde = s.source === 'file' ? '~' : '';
  if (s.used === null) return 'n/a';
  if (s.limit === null || s.limit <= 0) return `${formatTokens(s.used)} / ?${tilde}`;
  const pct = Math.round((s.used / s.limit) * 100);
  return `${pct}% · ${formatTokens(s.used)}/${formatTokens(s.limit)}${tilde}`;
}

/** Title cut to ~10 chars at a word break, with `…` when anything was dropped. */
export function cutTitle(title: string, max = 10): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let out = '';
  for (const w of t.split(' ')) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  if (!out) out = t.slice(0, max);
  return `${out}…`;
}

/** Traffic-light dot carries the level, so the label text keeps the theme colour (spec 7.1). */
export const LEVEL_DOT: Readonly<Record<Level, string>> = { healthy: '🟢', warn: '🟡', amber: '🟠', red: '🔴', none: '⚪' };

/** Status bar label: `🟡 Fix WSL path… · 62% · 159k/256k`. Trailing `~` = file source. */
export function formatLabel(s: Pick<Snapshot, 'title' | 'used' | 'limit' | 'source'>, level: Level): string {
  // Status bar text renders `$(name)` as an icon; escape it like vscode's escapeIcons.
  const title = cutTitle(s.title, 18).replace(/\$\(/g, '\\$(');
  return `${LEVEL_DOT[level]} ${title} · ${figures(s)}`;
}

/** The one Conversation the status bar shows: the Active one, never a Recent (spec 7.1). */
export function statusBarSnapshot<T extends Pick<Snapshot, 'role'>>(snaps: readonly T[]): T | null {
  return snaps.find((s) => s.role === 'active') ?? null;
}

function esc(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function k1(n: number): string { return `${(n / 1000).toFixed(1)}k`; }

/** Compaction tooltip lines (spec section 8); empty when none. */
export function compactionLines(s: Pick<Snapshot, 'compaction' | 'limit' | 'modelChanges'>): string[] {
  const out: string[] = [];
  const c = s.compaction;
  if (c) {
    let line = `Compacted ${c.count}×`;
    if (c.manual > 0) line += ` (${c.manual} manual)`;
    if (c.lastStep !== undefined) line += ` · last at step ${c.lastStep}`;
    if (c.was !== undefined) line += ` · was ${k1(c.was)}`;
    out.push(line);
    if (s.limit !== null && s.limit > 0) out.push(`Compacts at ~${formatTokens(s.limit)} (soft limit)`);
  }
  for (const m of s.modelChanges ?? []) out.push(`Model changed at step ${m.step}: ${esc(m.from)} → ${esc(m.to)}`);
  return out;
}

/** Tooltip markdown (rendered untrusted). Only fields available in file mode. */
export function formatTooltip(s: Snapshot, stale = false, threshold: Threshold | null = null, now: number = Date.now()): string {
  const lines: string[] = [];
  if (s.notSelected) lines.push('**Not selected:** last viewed Conversation in this window', '');
  lines.push(`**${esc(s.title)}**`, '');
  if (s.expiresAt !== undefined) lines.push(esc(countdownText(s.expiresAt - now)), '');
  lines.push(`Model: ${s.modelDisplay ? esc(s.modelDisplay) : 'unknown'}`);
  if (s.used === null) {
    lines.push('Used: n/a (no token counts in transcript)');
  } else {
    lines.push(`Used / limit: ${s.used.toLocaleString('en-US')} / ${s.limit !== null ? s.limit.toLocaleString('en-US') : 'unknown (limit unknown)'}`);
  }
  if (s.estimate !== null) lines.push(`Antigravity estimate: ${s.estimate.toLocaleString('en-US')}`);
  if (threshold && s.used !== null) {
    const pct = Math.round((s.used / threshold.tokens) * 100);
    const src = threshold.source === 'default' || threshold.source === 'context window'
      ? threshold.source : `\`threshold["${threshold.source.replace(/`/g, '')}"]\``;
    lines.push(`Threshold: ${pct}% of ${threshold.tokens.toLocaleString('en-US')} · ${src}`);
  }
  lines.push(`Limit source: ${s.limitSource}`);
  lines.push(`Data source: ${s.source}`);
  const t = s.totals;
  lines.push(`Totals: input ${t.input.toLocaleString('en-US')}, cache read ${t.cacheRead.toLocaleString('en-US')}, output ${t.output.toLocaleString('en-US')}, ${t.calls} calls`);
  lines.push(...compactionLines(s));
  if (stale) lines.push('', '_Stale: last file read failed; showing the last good snapshot._');
  return lines.join('\n\n');
}
