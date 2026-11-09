import { describe, expect, it } from 'vitest';
import { Logger, redact } from '../src/logger';

const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('redact', () => {
  it('drops the exact token', () => {
    expect(redact(`oops ${TOKEN} here`, TOKEN)).not.toContain(TOKEN);
  });
  it('drops csrf-shaped values by regex, flag and header form', () => {
    const other = '11111111-2222-3333-4444-555555555555';
    expect(redact(`--csrf_token=${other}`, undefined)).toBe('--csrf_token=‹redacted›');
    expect(redact(`X-Codeium-Csrf-Token: ${other}`, undefined)).toBe('X-Codeium-Csrf-Token: ‹redacted›');
  });
  it('drops emails', () => {
    expect(redact('user a.b@example.com logged', undefined)).toBe('user ‹redacted› logged');
  });
  it('leaves ordinary lines alone', () => {
    expect(redact('poll tick ok', undefined)).toBe('poll tick ok');
  });
});

describe('Logger', () => {
  it('honours the level and redacts every line', () => {
    const lines: string[] = [];
    const log = new Logger({ appendLine: (l) => lines.push(l) }, 'error', () => new Date(0));
    log.info('hidden');
    log.error(`bad --csrf_token=${TOKEN}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(TOKEN);
    log.setLevel('debug');
    log.debug('now visible');
    expect(lines).toHaveLength(2);
    log.setLevel('off');
    log.error('nope');
    expect(lines).toHaveLength(2);
  });
});
