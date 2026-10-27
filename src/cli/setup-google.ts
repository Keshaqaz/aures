// `aures setup` on Google Apps Script (ADR-0007): the Google sign-in, the deploy, the script's
// consent, then everything else through doPost with the secret: the rules, the ChatGPT sign-in,
// the schedule and the trial run. The install record keeps the project from the moment it
// exists, so a repeated or interrupted setup goes on in the same project and adds only what is
// missing. What the user sees is the stages of issue 30: one line per stage, its buttons and
// addresses told only to a user who waits.
import { randomUUID } from 'node:crypto';
import { deviceLogin, sessionEmail } from '../chatgpt/session.ts';
import type { Summary } from '../worker/summary.ts';
import type { WouldApply } from '../worker/tick.ts';
import { GoogleFailure } from '../google/api.ts';
import { PROJECT_TITLE } from '../apps-script/layout.ts';
import type { GoogleApi } from '../google/api.ts';
import { connectGoogle, deployWorker, askWorker, askAfterDeploy, workerDid, brokenOnGoogle, readSecret } from './google.ts';
import type { WorkerReply, WorkerDeployment } from './google.ts';
import { CommandFailed, failedRunAdvice, trialVerdict, workingLine, notReadYet, Stages, stagedCode, slowHint, doneLine, chatgptWhy,
  HINT_AFTER_MS } from './common.ts';
import type { Io, Sleep } from './common.ts';
import type { SetupOptions } from './setup.ts';
import type { GoogleWorker } from './watch-files.ts';
import type { RunOutcome } from '../apps-script/worker.ts';
import { t } from './language.ts';

// Until the script answers as authorized the CLI asks again this often.
const CONSENT_POLL_MS = 5_000;
// While the answer stays 'scopes', the consent page opens again no sooner than this long after
// the last opening: the user gets a fresh page to redo an incomplete consent, never a cycle of
// tabs (issue 29).
const CONSENT_REOPEN_MS = 60_000;
const COMMAND = 'setup';

// The buttons of the Google screens of the CLI's sign-in, as one line for a user who takes
// longer than a moment (issue 30): a chain through «→», with the address for a browser that
// did not open.
const signInHint = (url: string): string => t(
  `→ Signing in to Google: «Continue» → «Continue» → tick every box → «Continue». If the browser did not open: ${url}`,
  `→ Вход в Google: «Продолжить» → «Продолжить» → отметьте все галочки → «Продолжить». Если браузер не открылся: ${url}`);

// The same for the consent of the script (issue 30): the «aures-worker (Unverified)» page, the
// popup and its boxes.
const consentHint = (url: string): string => t(
  `→ Let the script run: «Review permissions» → the same account → «Advanced» → «Go to aures-worker (unsafe)» → ` +
    `tick both boxes → «Continue». Page: ${url}`,
  `→ Разрешите скрипту работать: «Review permissions» → тот же аккаунт → «Дополнительные настройки» → ` +
    `«Перейти на страницу "aures-worker" (небезопасно)» → обе галочки → «Продолжить». Страница: ${url}`);

// A consent that came back without every box (issue 29): what the reopened page wants, told
// the same deferred way.
const scopesHint = (url: string): string => t(
  `→ The consent gave not every access: tick both boxes (or «Select all») → «Continue». Page: ${url}`,
  `→ Согласие дало не все доступы: отметьте обе галочки (или «Выбрать все») → «Продолжить». Страница: ${url}`);

// What the trial run tells, by the reply of doPost trial. The line is what the screen's
// «Проверить сейчас» prints; setup ends with the short doneLine over resets instead (issue 30).
export interface Trial { outcome: RunOutcome; reason?: string; wouldApply: WouldApply | null; summary: Summary | null }
export interface TrialTold { line: string; resets: number | null; busy: boolean }
export function trialLine({ outcome, reason, wouldApply, summary }: Trial, timeZone: string | undefined): TrialTold {
  if (outcome === 'broken_state') {
    throw new CommandFailed(brokenOnGoogle(reason));
  }
  if (outcome === 'reauth_required') throw new CommandFailed(failedRunAdvice({ outcome }));
  const verdict = trialVerdict({ outcome, wouldApply: wouldApply ?? undefined });
  if (summary && outcome !== 'transient_error') {
    return { line: [workingLine(summary, timeZone), verdict].filter(Boolean).join(' '), resets: summary.resets?.length ?? 0, busy: false };
  }
  return { line: notReadYet(outcome === 'transient_error'), resets: null, busy: outcome === 'transient_error' };
}

export async function setupGoogle({ fetch, io, mac: { files }, open, copy, googleKeychain, secretKeychain, appsScriptSource, now, sleep, timeZone,
  paused, stages }: SetupOptions & { now: () => number; sleep: Sleep; paused: boolean; stages: Stages }): Promise<number> {
  // The record keeps a pause through the repair: the schedule is not brought back. The
  // accounts the sign-ins named stay with it.
  const remember = async (google: GoogleWorker) => {
    const accounts = (await files.readInstall())?.accounts;
    await files.writeInstall({ platform: 'google', google, ...paused ? { paused: true } : {}, ...accounts ? { accounts } : {} });
  };
  let google = (await files.readInstall())?.google ?? null;
  let secret = await readSecret(secretKeychain);
  const ask = (action: string, extra?: Record<string, unknown>) => {
    if (!google?.url || !secret) throw new Error('the worker is not deployed');
    return askWorker({ fetch, url: google.url, secret }, action, extra);
  };
  // Asks the worker; a reply that the script was not given every scope (issue 29) has the user
  // redo the consent: the page opens once, and consent() waits there until the worker's
  // authorization says every scope is given, reopening the page no more than once a minute.
  // Should the ask still meet a refusal after that — the authorization and the service
  // disagree — it waits with a pause and never opens the page again: a cycle of tabs helps
  // nobody (the review of issue 29). What the wait tells is deferred (issue 30): the pause is
  // the wait line, the boxes come to a user who takes longer than a moment.
  const asking = async (action: string, extra?: Record<string, unknown>): Promise<WorkerReply> => {
    const io = stageIo;
    let opened = false, since: number | null = null, told = false;
    try {
      for (;;) {
        const reply = await ask(action, extra);
        if (!reply || reply.error !== 'scopes') return workerDid(reply, COMMAND);
        if (!opened) {
          opened = true;
          await consent({ io, open, sleep, now, url: google?.url ?? '', ask, again: true });
          continue;
        }
        if (since === null) {
          since = now();
          io.wait(t('Waiting for every access of the script…', 'Ждём, когда скрипту выдадут все доступы…'));
        }
        if (!told && now() - since >= HINT_AFTER_MS) {
          told = true;
          io.print(scopesHint(google?.url ?? ''));
        }
        await sleep(CONSENT_POLL_MS);
      }
    } finally { io.wait(null); }
  };

  // What the worker is asked prints under the stage that asks.
  let stageIo: Io = io;

  // Stage 1: the sign-in of the CLI to Google — only when the worker needs one (issue 30); a
  // deployed worker that answers leaves the stage done at once.
  const account = async (): Promise<string | undefined> => (await files.readInstall())?.accounts?.google ?? undefined;
  const known = Boolean(google?.url && google.deploymentId && secret);
  let status: WorkerReply | null = null, deployed = known;
  if (known) {
    try {
      status = await ask('status');
      deployed = status?.error !== 'forbidden';
    } catch (error) {
      if (!(error instanceof GoogleFailure && error.reason === 'web_app_404' && google)) throw error;
      google = { scriptId: google.scriptId };
      deployed = false;
    }
  }
  const signIn = stages.begin(t('Signing in to Google', 'Вход в Google'),
    t('to create the worker project in your Google account', 'чтобы создать проект воркера в вашем аккаунте Google'));
  let api: GoogleApi | null = null;
  if (!deployed) api = await connectGoogle({ fetch, keychain: googleKeychain, io: signIn.io, open, now, files,
    sign: { waiting: url => slowHint(signIn.io, signInHint(url), { now }).stop } });
  // The account the sign-in named; a grant without the email is a sign-in all the same.
  signIn.done(await account() ?? (api ? t('signed in', 'вход выполнен') : t('already there', 'уже есть')));

  // Stage 2: the worker on Google — the deploy, the switch of the Apps Script API, the consent
  // of the script and the rules. The schedule and the trial run come after the worker's own
  // ChatGPT session, and the last line of setup tells what they said (issue 30).
  const workerStage = stages.begin(t('The worker on Google', 'Воркер в Google'),
    t('an Apps Script project in your account, where the worker runs', 'проект Apps Script в вашем аккаунте: в нём воркер и работает'));
  stageIo = workerStage.io;
  let steps = 0;
  const step = (text: string) => { steps++; workerStage.step(text); };
  if (api) {
    // A deployed worker answers to the secret in the Keychain; one that does not know it gets
    // a new one. A deployment the user deleted is made anew in the same project, under another
    // URL.
    const deploy = (deployment: GoogleWorker | null) => deployWorker({ api, secretKeychain, io: workerStage.io, open, sleep,
      workerSource: appsScriptSource, deployment, onProject: scriptId => remember(google = { scriptId }),
      apiSwitch: { off: workerStage.act, on: () => step(t('the Apps Script API is on', 'API скрипта включён')) } });
    let result: WorkerDeployment;
    try { result = await deploy(google); } catch (error) {
      // The user deleted the project: the worker starts over in a new one.
      if (!(error instanceof GoogleFailure && error.reason === 'update_content_404' && google)) throw error;
      workerStage.io.print(t('The worker project is gone from Google, creating a new one.', 'Проекта воркера в Google больше нет, создаём новый.'));
      result = await deploy(google = null);
    }
    await remember(google = result);
    step(t(`project ${PROJECT_TITLE}: the code is in`, `проект ${PROJECT_TITLE}: код загружен`));
    secret = await readSecret(secretKeychain);
    if (!secret) throw new Error('the worker is not deployed');
    // The live web app can still serve the previous version for a few seconds, answering
    // forbidden to the fresh secret; askAfterDeploy waits that out.
    status = await askAfterDeploy({ fetch, url: result.url, secret, now, sleep, io: workerStage.io, command: COMMAND });
  }
  // A script not allowed yet, or one whose consent lacks a scope (issue 29), goes through the
  // consent; in the latter case its hint says why it opens again.
  if (status === null || status.error === 'scopes') {
    status = await consent({ io: workerStage.io, open, sleep, now, url: google?.url ?? '', ask, again: status?.error === 'scopes' });
    step(t('the script is allowed to run', 'скрипту разрешено работать'));
  }
  status = workerDid(status, COMMAND);

  if (!status.rules) workerDid(await ask('rules', { rules: { beforeExpiry: true, weeklyAutoApply: true } }), COMMAND);
  workerStage.done(steps ? undefined : t('already in place', 'уже на месте'));

  // Stage 3: the worker's own session of ChatGPT. It comes before the schedule: a login into
  // a worker with no schedule spends nothing — it goes as a trial run — so the order is the
  // setup's own (the worker's doPost login decides by it).
  const chatgpt = stages.begin(t('Signing in to ChatGPT', 'Вход в ChatGPT'), chatgptWhy());
  stageIo = chatgpt.io;
  if (status.summary) chatgpt.done(t('already there', 'уже есть'));
  else {
    const code = stagedCode(chatgpt, open, copy, now);
    let session;
    try { session = await deviceLogin({ fetch, now, sleep, onCode: code.onCode }); } finally { code.ended(); }
    const id = randomUUID();
    const taken = await asking('login', { login: { id, session } });
    if ((taken.summary as Summary | null)?.login?.id !== id) {
      throw new CommandFailed(t(`The worker did not take the ChatGPT sign-in (${taken.outcome}${taken.reason ? `: ${taken.reason}` : ''}).`,
        `Воркер не принял вход в ChatGPT (${taken.outcome}${taken.reason ? `: ${taken.reason}` : ''}).`));
    }
    const email = sessionEmail(session);
    await files.rememberAccount('chatgpt', email);
    chatgpt.done(email ?? t('signed in', 'вход выполнен'));
  }

  // Stage 4: the schedule and the trial run; the screen the setup opens next shows what they did.
  const first = stages.begin(t('First run', 'Первый запуск'),
    t('the schedule every 5 minutes and a trial check that spends nothing', 'расписание каждые 5 минут и пробная проверка, которая ничего не тратит'));
  stageIo = first.io;
  if (paused) first.step(t('the worker is paused: its schedule stays off', 'воркер на паузе: расписание остаётся снятым'));
  else if (status.schedule === true) first.step(t('the schedule is already on', 'расписание уже включено'));
  else {
    await asking('schedule', { on: true });
    first.step(t('the schedule is on', 'расписание включено'));
  }
  const trial = trialLine(await asking('trial') as unknown as Trial, timeZone);
  first.done(t('the trial check passed', 'пробная проверка прошла'));
  io.print('');
  io.print(doneLine(trial.resets, { busy: trial.busy, paused }));
  return 0;
}

// Opens the web app for the owner to let the script run, and waits until the worker answers as
// authorized with every scope (issue 29): status answers 'scopes' until the consent gave both.
// A consent that comes back without every box opens the page again at once; later incomplete
// answers keep waiting, and the page opens again no sooner than CONSENT_REOPEN_MS after the
// last opening — so an incomplete consent is never met with a cycle of tabs. What to press is
// told only to a user who takes longer than a moment (issue 30): the polls of the wait carry
// the time; again tells that this call follows a 'scopes' answer, so the hint names the boxes.
async function consent({ io, open, sleep, url, ask, now, again = false }:
  { io: Io; open: (url: string) => Promise<void>; sleep: Sleep; url: string; now: () => number;
    ask: (action: string) => Promise<WorkerReply | null>; again?: boolean }): Promise<WorkerReply> {
  for (;;) {
    const opened = now();
    await open(url);
    io.wait(t('Waiting for the script to be allowed…', 'Ждём, когда скрипту разрешат работать…'));
    let told = false;
    try {
      for (;;) {
        const status = await ask('status');
        if (status && status.error !== 'scopes') return status;
        // The buttons of the consent, told once and only when the user takes longer than a
        // moment: a quick consent never sees them (issue 30).
        if (!told && now() - opened >= HINT_AFTER_MS) {
          told = true;
          io.print(again ? scopesHint(url) : consentHint(url));
        }
        // The consent the user just gave does not cover every box: the page opens again.
        // Later incomplete answers wait — the hint above tells, not silence — and reopen the
        // page only once a minute at most.
        if (status && !again) { again = true; break; }
        if (status && now() - opened >= CONSENT_REOPEN_MS) { again = true; break; }
        await sleep(CONSENT_POLL_MS);
      }
    } finally { io.wait(null); }
  }
}
