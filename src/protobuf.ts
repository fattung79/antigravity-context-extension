/** Tiny protobuf wire-format reader: navigate by field-number path, no schema. */

export interface PbField {
  num: number;
  wire: 0 | 1 | 2 | 5;
  /** varint => bigint, fixed64/fixed32 => bigint (raw LE), length-delimited => bytes */
  varint?: bigint;
  bytes?: Uint8Array;
}

export class ProtobufError extends Error {}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    const b = buf[pos + i];
    if (b === undefined) throw new ProtobufError('truncated varint');
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos + i + 1];
    shift += 7n;
  }
  throw new ProtobufError('varint too long');
}

export function decodeMessage(buf: Uint8Array): PbField[] {
  const fields: PbField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const num = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (num <= 0) throw new ProtobufError('bad field number');
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      fields.push({ num, wire: 0, varint: v });
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (pos + n > buf.length) throw new ProtobufError('truncated fixed');
      let v = 0n;
      for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[pos + i] ?? 0);
      pos += n;
      fields.push({ num, wire, varint: v });
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      const end = p2 + Number(len);
      if (end > buf.length) throw new ProtobufError('truncated bytes');
      fields.push({ num, wire: 2, bytes: buf.subarray(p2, end) });
      pos = end;
    } else {
      throw new ProtobufError(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

/** All fields at `path` (every level descends into the FIRST matching submessage; the last level returns all occurrences). */
export function getAll(buf: Uint8Array, path: readonly number[]): PbField[] {
  let cur = buf;
  for (let i = 0; i < path.length; i++) {
    const num = path[i]!;
    const matches = decodeMessage(cur).filter((f) => f.num === num);
    if (i === path.length - 1) return matches;
    const next = matches.find((f) => f.wire === 2 && f.bytes);
    if (!next?.bytes) return [];
    cur = next.bytes;
  }
  return [];
}

export function getVarint(buf: Uint8Array, path: readonly number[]): bigint | undefined {
  return getAll(buf, path).find((f) => f.wire === 0)?.varint;
}

export function getNumber(buf: Uint8Array, path: readonly number[]): number | undefined {
  const v = getVarint(buf, path);
  return v === undefined ? undefined : Number(v);
}

export function getString(buf: Uint8Array, path: readonly number[]): string | undefined {
  const f = getAll(buf, path).find((x) => x.wire === 2 && x.bytes);
  return f?.bytes ? Buffer.from(f.bytes).toString('utf8') : undefined;
}
