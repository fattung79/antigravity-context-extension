import type { Snapshot } from '../model';

export function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k).toString() : String(Math.round(k * 10) / 10)) + 'k';
  }
  return String(n);
}

export const EMPTY_LABEL = '◌ ctx —';
export const EMPTY_TOOLTIP = 'No Conversation yet';

/** Status bar label for the single Active item (spec 7.1). Trailing `~` = file source. */
export function formatLabel(s: Pick<Snapshot, 'used' | 'limit' | 'source'>): string {
  const tilde = s.source === 'file' ? '~' : '';
  if (s.used === null) return '◔ ctx n/a';
  if (s.limit === null || s.limit <= 0) return `◔ ctx ${formatTokens(s.used)} / ?${tilde}`;
  const pct = Math.round((s.used / s.limit) * 100);
  return `◔ ctx ${pct}% · ${formatTokens(s.used)}/${formatTokens(s.limit)}${tilde}`;
}

function esc(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

/** Tooltip markdown (rendered untrusted). Only fields available in file mode. */
export function formatTooltip(s: Snapshot, stale = false): string {
  const lines: string[] = [];
  if (s.notSelected) lines.push('**Not selected:** last viewed Conversation in this window', '');
  lines.push(`**${esc(s.title)}**`, '');
  lines.push(`Model: ${s.modelDisplay ? esc(s.modelDisplay) : 'unknown'}`);
  if (s.used === null) {
    lines.push('Used: n/a (no token counts in transcript)');
  } else {
    lines.push(`Used / limit: ${s.used.toLocaleString('en-US')} / ${s.limit !== null ? s.limit.toLocaleString('en-US') : 'unknown (limit unknown)'}`);
  }
  if (s.estimate !== null) lines.push(`Antigravity estimate: ${s.estimate.toLocaleString('en-US')}`);
  lines.push(`Limit source: ${s.limitSource}`);
  lines.push(`Data source: ${s.source}`);
  const t = s.totals;
  lines.push(`Totals: input ${t.input.toLocaleString('en-US')}, cache read ${t.cacheRead.toLocaleString('en-US')}, output ${t.output.toLocaleString('en-US')}, ${t.calls} calls`);
  if (stale) lines.push('', '_Stale: last file read failed; showing the last good snapshot._');
  return lines.join('\n\n');
}
