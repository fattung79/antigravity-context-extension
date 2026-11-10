/** Compaction + model-change detection from transcript steps (pure). Spec section 8. */

import type { Snapshot } from '../model';
import type { CompactStep } from './items';

/** Step index of the last Compaction CHECKPOINT, or null. */
export function lastCheckpointStep(steps: CompactStep[]): number | null {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.compaction) return steps[i]!.index;
  return null;
}

/**
 * count / manual / lastStep / was. Manual iff the nearest earlier USER_INPUT (with no model
 * reply in between) is `/compact`. `was` = last planner figure (input + cache read) before the last one.
 */
export function detectCompaction(steps: CompactStep[]): Snapshot['compaction'] {
  let count = 0;
  let manual = 0;
  let lastStep: number | undefined;
  let was: number | undefined;
  let lastPlanner: number | undefined;
  let pendingCommand = false;
  for (const s of steps) {
    if (s.compaction) {
      count++;
      if (pendingCommand) manual++;
      lastStep = s.index;
      was = lastPlanner;
      pendingCommand = false;
    } else if (s.type === 'USER_INPUT') {
      pendingCommand = Boolean(s.compactCommand);
    } else if (s.tokens) {
      lastPlanner = s.tokens.input + s.tokens.cacheRead;
      pendingCommand = false;
    }
  }
  if (count === 0) return null;
  const out: NonNullable<Snapshot['compaction']> = { count, manual };
  if (lastStep !== undefined) out.lastStep = lastStep;
  if (was !== undefined) out.was = was;
  return out;
}

/** Model changes from `Model Selection` settings-change messages (db only gives the latest model). */
export function detectModelChanges(steps: CompactStep[]): Snapshot['modelChanges'] {
  return steps.flatMap((s) => (s.modelChange ? [{ step: s.index, from: s.modelChange.from, to: s.modelChange.to }] : []));
}

/** Steps kept in the tree: from the last Compaction on (CHECKPOINT included). */
export function stepsFrom(steps: CompactStep[], startStep: number | null): CompactStep[] {
  return startStep === null ? steps : steps.filter((s) => s.index >= startStep);
}
