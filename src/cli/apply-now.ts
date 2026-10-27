import { CommandFailed, YES, resetName, attemptResult, deadline, byDeadline, failedRunAdvice, command } from './common.ts';
import type { CommandOptions, Sleep } from './common.ts';
import { openWorker } from './active-worker.ts';
import type { Worker } from './active-worker.ts';
import { brokenOnGoogle } from './google.ts';
import type { RunOutcome } from '../apps-script/worker.ts';
import type { Summary } from '../worker/summary.ts';
import { t } from './language.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What became of the chosen reset, told by the summary before and after the run. outcome is
// the run's, failed what the user does about a failed run.
interface Verdict { code: number; message: string }
function verdict({ creditId, before, after, outcome, failed }: { creditId: string; before: Summary | null; after: Summary | null;
  outcome: RunOutcome | null; failed: string | null }): Verdict {
  const name = resetName(creditId);
  if (after?.lastApplied?.creditId === creditId && !same(after.lastApplied, before?.lastApplied)) {
    return { code: 0, message: t(`Reset ${name} applied.`, `Сброс ${name} применён.`) };
  }
  const attempt = after?.lastAttempt;
  if (attempt?.creditId === creditId && attempt.reason === 'apply_now' && !same(attempt, before?.lastAttempt)) {
    return { code: 1, message: t(`Reset ${name} not applied: ${attemptResult(attempt.result)}.`,
      `Сброс ${name} не применён: ${attemptResult(attempt.result)}.`) };
  }
  if (failed) return { code: 1, message: failed };
  if (outcome === 'pending') {
    return { code: 1, message: t('The result is not known yet: the worker will settle it on its next run. Check later: `aures status`.',
      'Результат пока неизвестен: воркер уточнит его при следующем запуске. Проверьте позже: `aures status`.') };
  }
  if (outcome === 'transient_error') {
    return { code: 1, message: t('ChatGPT is temporarily unavailable, the reset is not applied. Try again later.',
      'ChatGPT временно недоступен, сброс не применён. Повторите позже.') };
  }
  return { code: 1, message: t(`Reset ${name} not applied: the worker was busy with an earlier attempt. Try again later.`,
    `Сброс ${name} не применён: воркер был занят прошлой попыткой. Повторите позже.`) };
}

// The resets the user picks from: null before the worker's first read. A worker on pause takes
// an application too (ADR-0007): its schedule being off is no obstacle.
export async function readyToApply(worker: Worker): Promise<{ before: Summary | null }> {
  return { before: (await worker.status()).summary as Summary | null };
}

// Applies the reset regardless of the rules and tells what became of it, in doPost apply_now.
// before is the summary the user chose the reset from; wait tells what the run waits for.
export interface ApplyResetOptions {
  worker: Worker;
  creditId: string;
  before: Summary | null;
  now: () => number;
  sleep: Sleep;
  wait: (text: string | null) => void;
}
export async function applyReset({ worker, creditId, before, wait }: ApplyResetOptions): Promise<Verdict> {
  wait(t('The worker on Google is applying the reset…', 'Воркер на Google применяет сброс…'));
  const reply = await worker.ask('apply_now', { creditId }).finally(() => wait(null));
  const outcome = reply.outcome as RunOutcome;
  const failed = outcome === 'broken_state' ? brokenOnGoogle(reply.reason) : outcome === 'reauth_required' ? failedRunAdvice({ outcome }) : null;
  return verdict({ creditId, before, after: reply.summary as Summary | null, outcome, failed });
}

// `aures apply-now`: «Применить сейчас». The user picks one of the resets the
// worker last published; the worker applies it in its own run regardless of the rules,
// and the command waits for the reply.
export async function applyNow(options: CommandOptions): Promise<number> {
  const { io, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone } = options;
  return command('apply-now', io, async () => {
    const worker = await openWorker(options, 'apply-now');
    const { before } = await readyToApply(worker);
    if (!before) {
      throw new CommandFailed(t('The resets are not read yet. Try again after the next worker run.',
        'Сбросы ещё не прочитаны. Повторите после следующего запуска воркера.'));
    }
    const resets = byDeadline(before.resets);
    if (!resets.length) throw new CommandFailed(t('No resets.', 'Сбросов нет.'));

    io.print(t('Resets:', 'Сбросы:'));
    resets.forEach((reset, i) => io.print(`  ${i + 1}. ${resetName(reset.creditId)} — ${deadline(reset, timeZone)}`));
    let chosen: Summary['resets'][number] | null = null;
    while (!chosen) {
      const answer = (await io.prompt(t('Reset number (Enter — cancel): ', 'Номер сброса (Enter — отмена): '))).trim();
      if (!answer) { io.print(t('Cancelled.', 'Отменено.')); return 0; }
      chosen = resets[Number(answer) - 1] ?? null;
      if (!/^\d+$/.test(answer) || !chosen) { chosen = null; io.print(t(`Type a number from 1 to ${resets.length}.`, `Введите номер от 1 до ${resets.length}.`)); }
    }
    const { creditId } = chosen;
    const confirmed = (await io.prompt(t(`Apply ${resetName(creditId)} now? A reset is single-use. [y/N] `,
      `Применить ${resetName(creditId)} сейчас? Сброс одноразовый. [y/N] `))).trim().toLowerCase();
    if (!YES.includes(confirmed)) { io.print(t('Cancelled.', 'Отменено.')); return 0; }

    io.print(t('Applying…', 'Применяем…'));
    const { code, message } = await applyReset({ worker, creditId, before, now, sleep, wait: io.wait });
    for (const line of message.split('\n')) io.print(line);
    return code;
  });
}
