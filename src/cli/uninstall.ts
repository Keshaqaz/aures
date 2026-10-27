import { GoogleFailure, revokeGoogle } from '../google/api.ts';
import { PROJECT_TITLE } from '../apps-script/layout.ts';
import { KeychainUnavailable, KeychainEntry, GITHUB_TOKEN_ACCOUNT } from './keychain.ts';
import type { Keychain } from './keychain.ts';
import { YES, command, capitalized, githubRepoStep } from './common.ts';
import { connectGoogle, askWorker, readSecret } from './google.ts';
import type { WorkerReply } from './google.ts';
import { projectUrl } from './active-worker.ts';
import { removeCheckLeftovers } from './launch-agent.ts';
import type { CommandOptions, Printer, Io, Mac } from './common.ts';
import type { GoogleWorker } from './watch-files.ts';
import { t } from './language.ts';
import { stat } from 'node:fs/promises';

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

// Where the user takes back the access of the worker script and of the CLI's Google sign-in.
const CONNECTIONS = 'https://myaccount.google.com/connections';
// The CLI's Desktop OAuth client, as the consent page and the connections page name it.
const GOOGLE_APP = 'aures';

// Has the worker on Google take off its triggers, revoke its session and drop the script's
// authorization (doPost uninstall), and tells the user how it went. true when it did all of it.
async function stopGoogleWorker({ fetch, secretKeychain, io }: Pick<CommandOptions, 'fetch' | 'secretKeychain'> & { io: Printer },
  url: string | undefined): Promise<boolean> {
  const secret = await readSecret(secretKeychain);
  let reply: WorkerReply | null = null, why: string | null = null;
  if (!url) why = t('setup is not finished', 'установка не завершена');
  else if (!secret) why = t('there is no worker secret in the Keychain of this Mac', 'в Связке ключей этого Mac нет секрета воркера');
  else {
    try { reply = await askWorker({ fetch, url, secret }, 'uninstall'); } catch (error) {
      if (!(error instanceof GoogleFailure)) throw error;
      why = error.reason === 'web_app_404' ? t('its web app is gone', 'его web app удалён') : t(`Google error (${error.reason})`, `ошибка Google (${error.reason})`);
    }
  }
  if (reply?.ok === true) {
    // The triggers are off, but the script keeps its state and authorization for a repeated uninstall to retry.
    if (reply.outcome === 'revoke_failed') {
      io.print(t(`The worker on Google is stopped, but its ChatGPT sign-in is not revoked: ChatGPT did not confirm the revocation (${reply.reason}). ` +
        'It goes with the project.',
      `Воркер на Google остановлен, но его вход в ChatGPT не отозван: ChatGPT не подтвердил отзыв (${reply.reason}). Он удалится вместе с проектом.`));
      return false;
    }
    io.print(reply.outcome === 'revoked' ? t('The worker on Google is stopped, its ChatGPT sign-in is revoked.', 'Воркер на Google остановлен, его вход в ChatGPT отозван.') :
      t('The worker on Google is stopped.', 'Воркер на Google остановлен.'));
    return true;
  }
  why ??= reply === null ? t('the script has no access', 'у скрипта нет доступа') : reply.error === 'forbidden' ?
    t('it does not take the secret of this Mac', 'он не принимает секрет этого Mac') : t(`it refused (${reply.error})`, `он отказал (${reply.error})`);
  io.print(t(`The worker on Google did not answer: ${why}. Its schedule and ChatGPT sign-in go with the project.`,
    `Воркер на Google не ответил: ${why}. Его расписание и вход в ChatGPT удалятся вместе с проектом.`));
  return false;
}

// Removes what the CLI can of the worker on Google: stops it, deletes its deployment, ends the
// CLI's Google sign-in and forgets both secrets. The project itself only the user can delete:
// the Apps Script API has no call for it. Returns the manual steps for what is left. locked
// keeps whether the line of a locked Keychain was printed, so it is said once for all entries.
async function removeGoogle(options: CommandOptions & { now: () => number }, google: GoogleWorker | null,
  locked: KeychainLocked): Promise<string[]> {
  const { fetch, googleKeychain, secretKeychain, io, open, now } = options;
  const stopped = google ? await stopGoogleWorker(options, google.url) : false;
  let token = await readSecret(googleKeychain);
  if (google?.deploymentId) {
    // The deployment goes with the project too, so a failure here does not stop the removal.
    try {
      const api = await connectGoogle({ fetch, keychain: googleKeychain, io, open, now });
      token = api.refreshToken;
      await api.deleteDeployment(google.scriptId, google.deploymentId);
      io.print(t('The worker\'s web app on Google is deleted.', 'Web app воркера на Google удалён.'));
    } catch (error) {
      if (!(error instanceof GoogleFailure)) throw error;
      io.print(t(`The worker's web app on Google is not deleted (${error.reason}). It goes with the project.`,
        `Web app воркера на Google не удалён (${error.reason}). Он удалится вместе с проектом.`));
    }
  }
  let ended = true;
  if (token) {
    try {
      await revokeGoogle(fetch, token);
      io.print(t('The aures sign-in to Google is revoked.', 'Вход aures в Google отозван.'));
    } catch (error) {
      if (!(error instanceof GoogleFailure)) throw error;
      ended = false;
    }
  }
  if (google || token) {
    await removeFromKeychain(io, [googleKeychain, secretKeychain], t('The Google sign-in and the worker secret are removed from the Keychain.',
      'Вход в Google и секрет воркера удалены из Связки ключей.'), locked);
  }
  const steps: string[] = [];
  if (google) {
    steps.push(t(`delete the project ${PROJECT_TITLE} on ${projectUrl(google.scriptId)}`,
      `удалите проект ${PROJECT_TITLE} на странице ${projectUrl(google.scriptId)}`));
    // The stopped worker has dropped its authorization itself (doPost uninstall), and the live
    // removal of 2026-10-24 left nothing of it on the connections page; one that did not answer
    // keeps its entry there for the user to take back.
    if (google.url && !stopped) steps.push(t(`take back the access of ${PROJECT_TITLE} on ${CONNECTIONS}`,
      `закройте доступ ${PROJECT_TITLE} на странице ${CONNECTIONS}`));
  }
  if (!ended) steps.push(t(`take back the access of ${GOOGLE_APP} on ${CONNECTIONS}`, `закройте доступ ${GOOGLE_APP} на странице ${CONNECTIONS}`));
  return steps;
}

// Whether the line of a Keychain that did not answer was printed already: the Google entries and
// the GitHub one share it, so the user reads the line once.
interface KeychainLocked { told: boolean }
const keychainLockedLine = (): string =>
  t('The Keychain is unavailable: delete the codex-auto-resets entry in it by hand.', 'Связка ключей недоступна: удалите в ней запись codex-auto-resets вручную.');

// Removes these Keychain entries and says so; a locked Keychain is named for the user to clean
// by hand — once, however many of its entries there were.
async function removeFromKeychain(io: Printer, entries: Keychain[], done: string, locked: KeychainLocked): Promise<void> {
  try {
    for (const entry of entries) await entry.remove();
    io.print(done);
  } catch (error) {
    if (!(error instanceof KeychainUnavailable)) throw error;
    if (!locked.told) { locked.told = true; io.print(keychainLockedLine()); }
  }
}

// What earlier versions left on this Mac (ADR-0009): everything the check from this Mac left —
// its agent, its log, the computer session and watch.json (removeCheckLeftovers) — and the
// GitHub sign-in in the Keychain. The session is not revoked, it ends by itself.
async function removeLeftovers({ mac, io, githubKeychain, locked }: { mac: Mac; io: Printer; githubKeychain: Keychain;
  locked: KeychainLocked }): Promise<void> {
  if (await removeCheckLeftovers(mac)) io.print(t('The check from this Mac of an earlier version is removed.', 'Проверка с этого Mac от прежней версии удалена.'));
  let github: string | null;
  try { github = await githubKeychain.read(); } catch (error) {
    if (!(error instanceof KeychainUnavailable)) throw error;
    if (!locked.told) { locked.told = true; io.print(keychainLockedLine()); }
    github = null;
  }
  if (github) {
    await removeFromKeychain(io, [githubKeychain], t('The GitHub sign-in of an earlier version is removed from the Keychain.',
      'Вход в GitHub от прежней версии удалён из Связки ключей.'), locked);
  }
}

// `aures uninstall`: removes the worker on Google (removeGoogle), what earlier versions left on
// this Mac, and the install record. Last come the steps only the user can do, with their links.
// githubKeychain is the Keychain entry of the GitHub sign-in of earlier versions.
export async function uninstall(options: CommandOptions & { githubKeychain?: Keychain }): Promise<number> {
  const { io, mac, now = Date.now, githubKeychain = new KeychainEntry(GITHUB_TOKEN_ACCOUNT) } = options;
  return command('uninstall', io, async () => {
    // What this run says at all: one that says nothing names what became of the install instead.
    let said = 0;
    const telling: Io = { ...io, print: line => { said++; io.print(line); } };
    const locked: KeychainLocked = { told: false };
    const install = await mac.files.readInstall();
    const google = install?.google ?? null;
    const github = await mac.files.githubInstall();
    const hadFiles = await exists(mac.files.dir);
    if (google) {
      telling.print(t(`This deletes the worker on Google (${projectUrl(google.scriptId)}: its schedule, ChatGPT sign-in and web app) and the Google sign-in in the Keychain.`,
        `Будут удалены воркер на Google (${projectUrl(google.scriptId)}: расписание, вход воркера в ChatGPT и web app) и вход в Google из Связки ключей.`));
      if (!YES.includes((await io.prompt(t('Delete? [y/N] ', 'Удалить? [y/N] '))).trim().toLowerCase())) {
        io.print(t('Cancelled.', 'Отменено.'));
        return 0;
      }
    }
    // Before removeAll, which takes the install record with it: a failure here leaves the record for a repeated uninstall.
    const steps = await removeGoogle({ ...options, io: telling, now }, google, locked);
    await removeLeftovers({ mac, io: telling, githubKeychain, locked });
    await mac.files.removeAll();
    // The worker of the removed GitHub platform (ADR-0009) runs while its repository is there.
    if (github) steps.push(githubRepoStep());
    if (!said && !steps.length) {
      io.print(hadFiles ? t('The aures files on this Mac are removed.', 'Файлы aures на этом Mac удалены.') :
        t('aures is not installed on this Mac: nothing to remove.', 'aures на этом Mac не установлен: удалять нечего.'));
    }
    if (steps.length === 1) io.print(`${t('Last step', 'Последний шаг')}: ${steps[0]}`);
    else if (steps.length) {
      io.print(t('Left to do by hand:', 'Осталось сделать вручную:'));
      steps.forEach((step, i) => io.print(`  ${i + 1}. ${capitalized(step)}`));
    }
    return 0;
  });
}
