import { getNumber, getString } from '../protobuf';

export interface GenMetadata {
  input: number | null;
  cacheRead: number;
  output: number | null;
  modelDisplay: string | null;
  limit: number | null;
  estimate: number | null;
  startStepIndex: number | null;
}

/** Decode a gen_metadata `data` blob by field path (spec 4.2). Never logs/returns the blob. */
export function decodeGenMetadata(blob: Uint8Array): GenMetadata {
  return {
    input: getNumber(blob, [1, 4, 2]) ?? null,
    cacheRead: getNumber(blob, [1, 4, 5]) ?? 0,
    output: getNumber(blob, [1, 4, 3]) ?? null,
    modelDisplay: getString(blob, [1, 21]) ?? null,
    limit: getNumber(blob, [1, 9, 10, 4]) ?? null,
    estimate: getNumber(blob, [1, 9, 10, 1]) ?? null,
    startStepIndex: getNumber(blob, [1, 9, 1]) ?? null,
  };
}
