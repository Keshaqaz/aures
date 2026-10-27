// «Починить» on the screen «Воркер» (CONTEXT.md): this version of the worker goes into the
// worker on Google again and the schedule comes back, unless the worker is on pause. The state,
// the rules, the ChatGPT sign-in and the journal are not touched: the bundle goes into the same
// deployment (redeployGoogle, as `upgrade` does) and the Script Properties stay.
import pkg from '../../package.json' with { type: 'json' };
import { CommandFailed, unfinished } from './common.ts';
import type { Sleep } from './common.ts';
import { redeployGoogle } from './upgrade.ts';
import type { RedeployOptions } from './upgrade.ts';
import type { Worker } from './active-worker.ts';
import { t } from './language.ts';

// The bundle is null when this install has no build of it.
export interface RepairOptions extends Omit<RedeployOptions, 'appsScriptSource'> {
  worker: Worker;
  appsScriptSource: string | null;
  // The worker opened again: it answers to the new secret of the deploy.
  reopen: () => Promise<Worker>;
  sleep: Sleep;
}

// Resolves to the worker to go on with and what to tell the user.
export async function repairWorker(options: RepairOptions): Promise<{ worker: Worker; message: string }> {
  const { mac: { files }, appsScriptSource } = options;
  const install = await files.readInstall();
  if (!install) throw new CommandFailed(unfinished());
  const paused = install.paused === true;
  if (appsScriptSource === null) {
    throw new CommandFailed(t('There is no worker build in this program. Reinstall it: `brew reinstall aures`.',
      'В этой программе нет сборки воркера. Переустановите её: `brew reinstall aures`.'));
  }
  await redeployGoogle({ ...options, appsScriptSource }, install.google);
  const repaired = await options.reopen();
  if (!paused) await repaired.ask('schedule', { on: true });
  return { worker: repaired, message: paused ?
    t(`The worker is repaired: version ${pkg.version} is in. The worker is paused, its schedule stays off.`,
      `Воркер починен: залита версия ${pkg.version}. Воркер на паузе, расписание осталось снятым.`) :
    t(`The worker is repaired: version ${pkg.version} is in, its schedule is back.`,
      `Воркер починен: залита версия ${pkg.version}, расписание вернулось.`) };
}
