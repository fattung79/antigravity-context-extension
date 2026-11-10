import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

const files = walk(path.join(__dirname, '..', 'src'));
const code = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('forbidden patterns in src/', () => {
  it.each([
    ['environ', /\/environ|['"`]environ/],
    ['GetUserStatus', /GetUserStatus/],
    ['fs.watch', /\bfs\.watch|\bwatchFile\b|\bwatch\(/],
  ])('no %s in code', (_n, re) => {
    const hits = files.filter((f) => re.test(code(f)));
    expect(hits).toEqual([]);
  });
});
