// The worker journal (CONTEXT.md, «Журнал воркера») as the CLI reads it: the ring buffer of
// the worker on Google, each entry saying when the run started, what started it, how it ended
// and how long it took, with one `doPost status`. How long the platform took to answer the
// poll comes back with the entries; the screen of the worker shows it as its live line.
import type { RunOutcome } from '../apps-script/worker.ts';
import type { WouldApply } from '../worker/tick.ts';
import type { JournalEntry as RingEntry, RunKind } from '../apps-script/worker.ts';
import type { Worker } from './active-worker.ts';

export type JournalKind = RunKind;
export interface JournalEntry {
  // ISO time the run started.
  at: string;
  kind: JournalKind;
  // null while the run is not finished or its outcome does not read.
  outcome: RunOutcome | null;
  durationMs: number;
  reason?: string;
  // What the rules would apply, for a trial run that found a reset for them.
  wouldApply?: WouldApply;
}

// The entries, oldest first as the ring buffer keeps them, with the time of the poll and
// whether the schedule is on: the screens take the state of the worker from them.
export interface Journal { entries: JournalEntry[]; readAt: number; responseMs: number; schedule: boolean }

export interface JournalOptions { now?: () => number }

export async function readJournal(worker: Worker, { now = Date.now }: JournalOptions = {}): Promise<Journal> {
  const readAt = now();
  const status = await worker.status();
  const responseMs = now() - readAt;
  const read = Array.isArray(status.journal) ? status.journal as RingEntry[] : [];
  const entries = read.map(({ at, kind, outcome, durationMs, reason, wouldApply }) =>
    ({ at, kind, outcome, durationMs, ...(reason !== undefined ? { reason } : {}), ...(wouldApply ? { wouldApply } : {}) }));
  return { entries, readAt, responseMs, schedule: status.schedule === true };
}
