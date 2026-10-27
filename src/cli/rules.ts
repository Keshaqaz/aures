import { chooseRules, command } from './common.ts';
import type { CommandOptions, Printer } from './common.ts';
import { openWorker, rulesOf } from './active-worker.ts';
import type { Worker } from './active-worker.ts';
import type { Rules } from '../worker/state-file.ts';
import { t } from './language.ts';

// The rules as the worker keeps them now: current is undefined when there are none or, with
// broken naming why, when they do not read. write puts other rules in their place.
export interface StoredRules { current: Rules | undefined; broken: string | null; write(rules: Rules): Promise<void> }
export async function storedRules(worker: Worker): Promise<StoredRules> {
  return { current: rulesOf((await worker.status()).rules) ?? undefined, broken: null,
    write: async ({ beforeExpiry, weeklyAutoApply }) => { await worker.ask('rules', { rules: { beforeExpiry, weeklyAutoApply } }); } };
}

// Writes the chosen rules over the stored ones.
export interface SaveRulesOptions {
  stored: StoredRules;
  chosen: Rules;
  io: Printer;
}
export async function saveRules({ stored: { current, write }, chosen, io }: SaveRulesOptions): Promise<void> {
  if (current && chosen.beforeExpiry === current.beforeExpiry && chosen.weeklyAutoApply === current.weeklyAutoApply) {
    io.print(t('The rules did not change.', 'Правила не изменились.'));
  } else {
    await write(chosen);
    io.print(t('The rules are saved and take effect from the next worker run.', 'Правила сохранены и заработают со следующего запуска воркера.'));
  }
}

// `aures rules`: switches the general rules. The CLI is the only writer of the rules; the
// worker reads them on every run, so a change works from the next one.
export async function rules(options: CommandOptions): Promise<number> {
  const { io } = options;
  return command('rules', io, async () => {
    const worker = await openWorker(options, 'rules');
    const stored = await storedRules(worker);
    if (stored.broken) io.print(t(`The rules do not read (${stored.broken}), choose them again.`, `Правила не читаются (${stored.broken}), выберите их заново.`));
    const chosen = await chooseRules(io, stored.current);
    await saveRules({ stored, chosen, io });
    return 0;
  });
}
