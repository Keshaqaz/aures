import pkg from '../../package.json' with { type: 'json' };
import { GoogleFailure } from '../google/api.ts';
import { CommandFailed, unfinished, notInstalled, command } from './common.ts';
import type { CommandOptions, Sleep } from './common.ts';
import { connectGoogle, deployWorker, askAfterDeploy, workerDid, readSecret } from './google.ts';
import type { GoogleWorker } from './watch-files.ts';
import { t } from './language.ts';

const updatedLine = (): string => t(`The worker is updated to ${pkg.version}. The changes take effect from the next run.`,
  `Воркер обновлён до версии ${pkg.version}. Изменения заработают со следующего запуска.`);

// `aures upgrade`, after `brew upgrade`: puts this version's worker into the worker of this
// install on Google. Nothing changes the code that runs with the user's session until the user
// runs this. The worker migrates its state and rules itself when it reads them. The agent left
// by the check from this Mac (ADR-0009) goes first: it would run a command that is gone.
// appsScriptSource is the Apps Script worker bundle.
export interface UpgradeOptions extends CommandOptions { appsScriptSource: string }
export async function upgrade(options: UpgradeOptions): Promise<number> {
  const { io, mac: { files, agent }, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  return command('upgrade', io, async () => {
    await agent.remove();
    const install = await files.readInstall();
    if (!install) throw new CommandFailed(notInstalled());
    await redeployGoogle({ ...options, now, sleep }, install.google);
    io.print(updatedLine());
    return 0;
  });
}

// Puts this version of the worker on Google into the same project and deployment, so the web
// app keeps its URL, and the Script Properties with the state, the rules and the journal stay as
// they are: what `upgrade` and «Починить» do. The doPost secret is new, as on every deploy. A
// Google sign-in that ended opens again. The schedule is left as it is.
export type RedeployOptions = Pick<UpgradeOptions, 'fetch' | 'googleKeychain' | 'secretKeychain' | 'io' | 'open' | 'mac' | 'appsScriptSource'> &
  { now: () => number; sleep: Sleep };
export async function redeployGoogle({ fetch, googleKeychain, secretKeychain, io, open, mac, appsScriptSource, now, sleep }: RedeployOptions,
  google: GoogleWorker | undefined): Promise<void> {
  const { deploymentId, url } = google ?? {};
  if (!google || !deploymentId || !url) throw new CommandFailed(unfinished());
  const api = await connectGoogle({ fetch, keychain: googleKeychain, io, open, now, files: mac.files });
  try {
    await deployWorker({ api, secretKeychain, io, open, sleep, workerSource: appsScriptSource, deployment: { scriptId: google.scriptId, deploymentId } });
  } catch (error) {
    if (!(error instanceof GoogleFailure && ['update_content_404', 'update_deployment_404'].includes(error.reason))) throw error;
    throw new CommandFailed(t('The worker project or its deployment is gone from Google. Run `aures setup`: it deploys the worker anew.',
      'Проекта или развёртывания воркера в Google больше нет. Запустите `aures setup`: он развернёт воркер заново.'));
  }
  // The web app of the just-updated deployment can still serve the previous version, answering
  // forbidden to the fresh secret; askAfterDeploy waits that out. The new version answers to the
  // new secret — or says the script was not given every scope at its consent (issue 29), which
  // tells the user to redo the consent instead of a vague success.
  const secret = await readSecret(secretKeychain);
  const reply = secret && await askAfterDeploy({ fetch, url, secret, now, sleep, io, command: 'upgrade' });
  if (!reply) {
    throw new CommandFailed(t('The worker is updated, but the script has to be allowed to run again: run `aures setup`.',
      'Воркер обновлён, но скрипту нужно снова разрешить работать: запустите `aures setup`.'));
  }
  // A reply that is not ok tells its own story: 'scopes' says to redo the consent at `aures setup`.
  workerDid(reply, 'upgrade');
}
