// The Google sign-in of the CLI and the deploy of the worker to Apps Script: what setup,
// upgrade and «Починить» share (ADR-0007).
import { randomBytes } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { GoogleApi, GoogleFailure, ScopesMissing, googleLogin, postWorker } from '../google/api.ts';
import type { GoogleScope, ScriptFile } from '../google/api.ts';
import type { Fetch } from '../chatgpt/http.ts';
import { MANIFEST, PROJECT_FILES, PROJECT_TITLE, secretSource } from '../apps-script/layout.ts';
import { KeychainUnavailable } from './keychain.ts';
import type { Keychain } from './keychain.ts';
import type { OpenUrl } from './browser.ts';
import type { WatchFiles } from './watch-files.ts';
import { CommandFailed } from './common.ts';
import type { Io, Printer, Sleep } from './common.ts';
import { t } from './language.ts';

export const USER_SETTINGS = 'https://script.google.com/home/usersettings';
// The switch takes effect at once (probe 01); the CLI asks again this often.
const API_POLL_MS = 5_000;
// A web app keeps serving the previous version of its deployment for a few seconds after the
// deployment is updated, answering forbidden to the fresh secret (probe 16: ~2 s). The first
// ask after a deploy retries a forbidden this often, up to this long, before it is taken for a
// real refusal.
const TAKEOVER_POLL_MS = 3_000, TAKEOVER_WAIT_MS = 60_000;

// The box of the consent page, as the user looks for it.
const scopeName = (scope: GoogleScope): string => ({
  projects: t('your Google Apps Script projects', 'проекты Google Apps Script'),
  deployments: t('deployments of your Google Apps Script projects', 'развёртывания проектов Google Apps Script'),
})[scope];

// files keeps the email of a new sign-in; fresh signs in anew even with a sign-in in the Keychain.
// sign is setup's stage (issue 30): waiting arms, for the address googleLogin is about to open,
// the one short hint of a user who takes longer than a moment and returns what ends it, and the
// sign-in prints nothing of its own — the stage's ✓ says the account. Without sign everything
// prints at once, as the screen and the switch show it.
export interface ConnectGoogleOptions {
  fetch: Fetch; keychain: Keychain; io: Printer; open: OpenUrl; now: () => number;
  files?: Pick<WatchFiles, 'rememberAccount'>; fresh?: boolean;
  sign?: { waiting(url: string): () => void };
}

// The Google grant of the CLI. A refresh token from the Keychain is used while Google takes it;
// a gone one (revoked or expired) opens the sign-in again without a word about it.
export async function connectGoogle({ fetch, keychain, io, open, now, files, fresh = false, sign }: ConnectGoogleOptions): Promise<GoogleApi> {
  let token: string | null = null;
  if (!fresh) try { token = await keychain.read(); } catch (error) { if (!(error instanceof KeychainUnavailable)) throw error; }
  if (token) {
    const api = new GoogleApi({ fetch, now, refreshToken: token });
    try {
      await api.accessToken();
      return api;
    } catch (error) { if (!(error instanceof GoogleFailure && error.reason === 'invalid_grant')) throw error; }
  }
  for (;;) {
    if (!sign) {
      io.print(t('Sign in to Google in the browser. On the «Google hasn\'t verified this app» screen click «Continue», ' +
        'then «Continue» again on the «Sign in to aures» screen.',
      'Вход в Google в браузере. На экране «Эксперты Google не проверяли это приложение» нажмите «Продолжить», ' +
        'затем ещё раз «Продолжить» на экране «Вход в сервис "aures"».'));
      io.print(t('Then tick every box (or «Select all») and click «Continue».',
        'Затем отметьте все галочки (или «Выбрать все») и нажмите «Продолжить».'));
    }
    // The hint of a slow user ends when the sign-in does, whether the browser came back
    // while open was still running or after it.
    const hint: { stop: (() => void) | null } = { stop: null };
    try {
      const grant = await googleLogin({ fetch, now, open: url => {
        hint.stop?.();
        if (sign) hint.stop = sign.waiting(url);
        else io.print(t(`If the browser did not open: ${url}`, `Если браузер не открылся: ${url}`));
        return open(url);
      } });
      try { await keychain.write(grant.refreshToken); } catch (error) {
        if (!(error instanceof KeychainUnavailable)) throw error;
        io.print(t('Could not save the sign-in to the Keychain: Google will ask you to sign in again next time.',
          'Не удалось сохранить вход в Связку ключей: в следующий раз Google попросит войти снова.'));
      }
      await files?.rememberAccount('google', grant.email);
      if (!sign) io.print(grant.email ? t(`Signed in to Google as ${grant.email}.`, `Вы вошли в Google как ${grant.email}.`) :
        t('Signed in to Google.', 'Вы вошли в Google.'));
      return new GoogleApi({ fetch, now, refreshToken: grant.refreshToken, access: grant.access });
    } catch (error) {
      if (!(error instanceof ScopesMissing)) throw error;
      io.print(t(`Google did not give access to: ${error.missing.map(scopeName).join(', ')}. aures needs it to install the worker. ` +
        'Sign in again and tick these boxes.',
      `Google не дал доступ к: ${error.missing.map(scopeName).join(', ')}. Без него aures не установит воркер. ` +
        'Войдите снова и отметьте эти галочки.'));
    } finally { hint.stop?.(); }
    // The catch above left the loop going: the user signs in again with every box ticked.
  }
}

// Where the worker is deployed: its project, the deployment and the URL of its web app.
export interface WorkerDeployment { scriptId: string; deploymentId: string; url: string }

export interface DeployWorkerOptions {
  api: GoogleApi;
  // Where the doPost secret goes.
  secretKeychain: Keychain;
  io: Io;
  open: OpenUrl;
  sleep: Sleep;
  // The Apps Script bundle.
  workerSource: string;
  // The deployment to update, or what an interrupted deploy left: a project without one.
  deployment: { scriptId: string; deploymentId?: string | null } | null;
  // Told the project as soon as it exists, so that an interrupted deploy does not make another.
  onProject?: (scriptId: string) => unknown;
  // Setup's stage tells the switch of the Apps Script API: off with what to press, on once it is.
  apiSwitch?: { off(text: string): void; on(): void };
}

// Puts this version of the worker into the user's script project with a fresh doPost secret:
// create the project when there is none, replace its files, freeze them as a version and point
// the deployment at it. An existing deployment is updated, so its web app keeps its URL. The
// secret reaches the Keychain once the deployment serves it.
export async function deployWorker({ api, secretKeychain, io, open, sleep, workerSource, deployment, onProject, apiSwitch }: DeployWorkerOptions):
  Promise<WorkerDeployment> {
  let waiting = false, on = false;
  // The first call to the Apps Script API fails until the user turns it on; there is no API for that.
  const enabled = async <T>(call: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        const result = await call();
        if (waiting && apiSwitch && !on) {
          on = true;
          io.wait(null);
          apiSwitch.on();
        }
        return result;
      } catch (error) {
        if (!(error instanceof GoogleFailure && error.reason === 'api_disabled')) throw error;
      }
      if (!waiting) {
        waiting = true;
        // Told at once (issue 30): without the switch the step cannot pass, so the user
        // must know what to press before the wait can grow long. Setup tells it in its stage.
        if (apiSwitch) apiSwitch.off(t(`Turn on the Apps Script API: ${USER_SETTINGS}, the line «Google Apps Script API» → its switch`,
          `Включите API скрипта: ${USER_SETTINGS}, строка «API скрипта приложений Google Apps» → переключатель`));
        else {
          io.print(t(`Turn on the Apps Script API: on ${USER_SETTINGS} open the line «Google Apps Script API» and click its switch. ` +
            'aures goes on by itself.',
          `Включите API скрипта Google Apps: на ${USER_SETTINGS} откройте строку «API скрипта приложений Google Apps» и нажмите переключатель. ` +
            'aures продолжит сам.'));
        }
        await open(USER_SETTINGS);
        io.wait(apiSwitch ? t('waiting, aures goes on by itself', 'ждём, aures продолжит сам') :
          t('Waiting for the Apps Script API to be on…', 'Ждём, когда API скрипта Google Apps включится…'));
      }
      await sleep(API_POLL_MS);
    }
  };
  try {
    let scriptId = deployment?.scriptId;
    if (!scriptId) {
      scriptId = await enabled(() => api.createProject(PROJECT_TITLE));
      await onProject?.(scriptId);
    }
    const project = scriptId;
    const secret = randomBytes(24).toString('base64url');
    const files: ScriptFile[] = [
      { name: PROJECT_FILES.manifest, type: 'JSON', source: JSON.stringify(MANIFEST, null, 2) },
      { name: PROJECT_FILES.worker, type: 'SERVER_JS', source: workerSource },
      { name: PROJECT_FILES.secret, type: 'SERVER_JS', source: secretSource(secret) },
    ];
    await enabled(() => api.updateContent(project, files));
    const description = `aures ${pkg.version}`;
    const versionNumber = await enabled(() => api.createVersion(project, description));
    const config = { versionNumber, manifestFileName: PROJECT_FILES.manifest, description };
    const deploymentId = deployment?.deploymentId;
    const deployed = await enabled(() => deploymentId ? api.updateDeployment(project, deploymentId, config) : api.createDeployment(project, config));
    try { await secretKeychain.write(secret); } catch (error) {
      if (!(error instanceof KeychainUnavailable)) throw error;
      throw new CommandFailed(t('Could not save the worker secret to the Keychain. Unlock it and try again.',
        'Не удалось сохранить секрет воркера в Связку ключей. Разблокируйте её и повторите.'));
    }
    return { scriptId: project, ...deployed };
  } finally { if (waiting) io.wait(null); }
}

// What doPost answered: { ok: true, … } or { ok: false, error }; null while the script is not authorized.
export type WorkerReply = Record<string, unknown>;

// The doPost secret of this Mac; null when there is none or the Keychain is locked.
export const readSecret = async (keychain: Pick<Keychain, 'read'>): Promise<string | null> => {
  try { return await keychain.read(); } catch (error) { if (error instanceof KeychainUnavailable) return null; throw error; }
};

// What the user learns of a worker on Google whose data does not read.
export const brokenOnGoogle = (reason: unknown): string => t(`The worker data in the Google project does not read (${reason}).`,
  `Данные воркера в проекте Google не читаются (${reason}).`);

// One doPost of the worker with the secret from the Keychain.
export async function askWorker({ fetch, url, secret }: { fetch: Fetch; url: string; secret: string }, action: string,
  extra: Record<string, unknown> = {}): Promise<WorkerReply | null> {
  return postWorker(fetch, url, { ...extra, secret, action });
}

// The reply of an authorized worker that did what it was asked; otherwise the failure, explained.
// command names what to repeat, null an action on the screen, as in explain.
export function workerDid(reply: WorkerReply | null, command: string | null): WorkerReply {
  if (reply?.ok === true) return reply;
  const again = command === null ? t('Try again', 'Повторите') : t(`Run \`aures ${command}\` again`, `Повторите \`aures ${command}\``);
  const error = reply === null ? 'unauthorized' : String(reply.error);
  throw new CommandFailed(({
    busy: t(`The worker is busy with another run. ${again}.`, `Воркер занят другим запуском. ${again}.`),
    unauthorized: t(`The worker script has no access yet. ${again}.`, `У скрипта воркера ещё нет доступа. ${again}.`),
    scopes: t('The worker script was not given every access at its consent: not every box was ticked. ' +
      'Run `aures setup` — it opens the consent again; tick both boxes (or «Select all») and click «Continue».',
      'Скрипту воркера на согласии выданы не все доступы: отмечены не все галочки. ' +
      'Запустите `aures setup` — он откроет согласие ещё раз; отметьте обе галочки (или «Выбрать все») и нажмите «Продолжить».'),
    internal: t(`The worker script failed: ${String(reply?.message)}. ${again}.`, `Скрипт воркера упал: ${String(reply?.message)}. ${again}.`),
  } as Record<string, string>)[error] ?? t(`The worker refused (${error}). ${again}.`, `Воркер отказал (${error}). ${again}.`));
}

// The first ask of the worker right after deployWorker: the live web app keeps serving the
// previous version for a few seconds, so a forbidden is asked again with a pause until the new
// version takes over. null — the script not allowed yet — is returned as it is, for the caller's
// wait for consent; a forbidden that outlasts the window is a failure of its own. command names
// what to repeat, as in workerDid.
export async function askAfterDeploy({ fetch, url, secret, now, sleep, io, command }:
  { fetch: Fetch; url: string; secret: string; now: () => number; sleep: Sleep; io: Io; command: string | null }):
  Promise<WorkerReply | null> {
  let waiting = false;
  const until = now() + TAKEOVER_WAIT_MS;
  try {
    for (;;) {
      const reply = await askWorker({ fetch, url, secret }, 'status');
      if (reply?.error !== 'forbidden') return reply;
      if (!waiting) {
        waiting = true;
        io.wait(t('Waiting for Google to serve the new version of the worker…', 'Ждём, когда Google начнёт отдавать новую версию воркера…'));
      }
      if (now() >= until) {
        const again = command === null ? t('Try again', 'Повторите') : t(`Run \`aures ${command}\` again`, `Повторите \`aures ${command}\``);
        throw new CommandFailed(t(`The worker's web app still answers with its previous version: the new one has not taken over in a minute. ` +
          `${again} in a few minutes.`,
        `Web app воркера всё ещё отвечает прежней версией: новая не вступила в силу за минуту. ${again} через несколько минут.`));
      }
      await sleep(TAKEOVER_POLL_MS);
    }
  } finally { if (waiting) io.wait(null); }
}
