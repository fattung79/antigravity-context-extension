import { describe, expect, it } from 'vitest';
import { decodeGenMetadata } from '../src/sources/genMetadata';
import { decodeMessage, getAll, getNumber, getString } from '../src/protobuf';

function varint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}
const tag = (num: number, wire: number) => varint((num << 3) | wire);
const vf = (num: number, v: number | bigint) => [...tag(num, 0), ...varint(v)];
const lf = (num: number, payload: number[] | Uint8Array) => [...tag(num, 2), ...varint(payload.length), ...payload];
const sf = (num: number, s: string) => lf(num, [...Buffer.from(s, 'utf8')]);

function blob(opts: { cache?: boolean } = {}): Uint8Array {
  const usage = [...vf(2, 12345), ...(opts.cache === false ? [] : vf(5, 150000)), ...vf(3, 321)];
  const window = [...vf(1, 160000), ...vf(4, 256000)];
  const nine = [...vf(1, 25), ...lf(10, window)];
  const one = [...lf(4, usage), ...lf(9, nine), ...sf(21, 'Gemini 3.8 Flash (Medium)')];
  return Uint8Array.from([...lf(1, one), ...vf(7, 1)]);
}

describe('protobuf', () => {
  it('decodes top-level fields and nested paths', () => {
    expect(decodeMessage(blob()).map((f) => f.num)).toEqual([1, 7]);
    expect(getNumber(blob(), [1, 4, 2])).toBe(12345);
    expect(getString(blob(), [1, 21])).toBe('Gemini 3.8 Flash (Medium)');
    expect(getAll(blob(), [1, 99])).toEqual([]);
  });

  it('handles multi-byte and large varints', () => {
    expect(getNumber(Uint8Array.from(vf(1, 2 ** 40)), [1])).toBe(2 ** 40);
  });

  it('throws on truncated input', () => {
    expect(() => decodeMessage(Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow();
  });
});

describe('decodeGenMetadata', () => {
  it('extracts tokens, model, limit, estimate and start step', () => {
    expect(decodeGenMetadata(blob())).toEqual({
      input: 12345, cacheRead: 150000, output: 321,
      modelDisplay: 'Gemini 3.8 Flash (Medium)', limit: 256000, estimate: 160000, startStepIndex: 25, breakdown: null,
    });
  });

  it('treats absent cache read as 0', () => {
    expect(decodeGenMetadata(blob({ cache: false })).cacheRead).toBe(0);
  });
});
