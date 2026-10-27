import type { State, Rules, ApplyReason, AttemptResult, LoginVerdict } from './state-file.ts';

// What the worker publishes openly for `status`: never the session, the account id or
// the pending redeem_request_id. Every field is copied explicitly, nothing is spread. pending
// names the reset whose application has no known outcome yet; a summary without the field is
// from an older worker.
export const SUMMARY_FORMAT_VERSION = 1;
function iso(ms: number): string;
function iso(ms: number | null): string | null;
function iso(ms: number | null): string | null { return ms == null ? null : new Date(ms).toISOString(); }

// Times are ISO strings; expiresAt is null for a reset without a deadline.
export interface Summary {
  formatVersion: number;
  resets: { creditId: string; expiresAt: string | null }[];
  rules: { beforeExpiry: boolean; weeklyAutoApply: boolean };
  lastApplied: { creditId: string; reason: ApplyReason; at: string } | null;
  lastAttempt: { creditId: string; reason: ApplyReason; result: AttemptResult; at: string } | null;
  login: { id: string; result: LoginVerdict['result']; at: string } | null;
  pending?: { creditId: string; reason: ApplyReason; at: string } | null;
}

// The summary has no tick time: the time of every run is in the journal of the worker.
export function openSummary({ state, rules }: { state: State; rules: Rules }): Summary {
  const applied = state.applied?.at(-1);
  const attempt = state.lastAttempt;
  const pending = state.pending;
  // The tick reads the list before it applies a reset, so the list still has the one applied.
  const spent = new Set((state.applied ?? []).map(a => a.creditId));
  return {
    formatVersion: SUMMARY_FORMAT_VERSION,
    resets: (state.observed?.resets ?? []).filter(reset => !spent.has(reset.id))
      .map(reset => ({ creditId: reset.id, expiresAt: iso(reset.expiresAt) })),
    rules: { beforeExpiry: rules.beforeExpiry, weeklyAutoApply: rules.weeklyAutoApply },
    lastApplied: applied ? { creditId: applied.creditId, reason: applied.reason, at: iso(applied.at) } : null,
    lastAttempt: attempt ? { creditId: attempt.creditId, reason: attempt.reason, result: attempt.result, at: iso(attempt.at) } : null,
    // The verdict on the latest `login`, which the CLI matches by id.
    login: state.login ? { id: state.login.id, result: state.login.result, at: iso(state.login.at) } : null,
    pending: pending ? { creditId: pending.creditId, reason: pending.reason, at: iso(pending.at) } : null,
  };
}
