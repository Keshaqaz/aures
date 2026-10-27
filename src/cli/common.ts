// What every command shares: a worker run's outcome, the words the user sees when something
// fails, and the stages of setup.
import { LoginFailed } from '../chatgpt/session.ts';
import type { DeviceCode } from '../chatgpt/session.ts';
import { TransientFailure } from '../chatgpt/http.ts';
import type { Fetch } from '../chatgpt/http.ts';
import { GoogleFailure } from '../google/api.ts';
import type { GoogleFailureReason } from '../google/api.ts';
import { RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import type { Rules, ApplyReason, AttemptResult } from '../worker/state-file.ts';
import type { RunOutcome } from '../apps-script/worker.ts';
import type { WouldApply } from '../worker/tick.ts';
import type { Summary } from '../worker/summary.ts';
import type { MacFiles } from './mac-files.ts';
import type { LaunchAgent } from './launch-agent.ts';
import type { Keychain } from './keychain.ts';
import type { OpenUrl, CopyText } from './browser.ts';
import { t } from './language.ts';

export type Sleep = (ms: number) => Promise<unknown>;
// Where a command tells the user what goes on.
export interface Printer { print(line: string): void }
// The user at the terminal: wait(text) shows what a command waits for, wait(null) ends it.
export interface Io extends Printer {
  prompt(question: string): Promise<string>;
  wait(text: string | null): void;
  color?: boolean;
  width?: number;
}
// What main hands every command; now, sleep and timeZone are the real ones unless a test sets them.
export interface CommandOptions {
  fetch: Fetch;
  // The Google sign-in and the doPost secret of the worker on Apps Script.
  googleKeychain: Keychain;
  secretKeychain: Keychain;
  // Opens a page in the browser.
  open: OpenUrl;
  // Puts a code on the clipboard.
  copy: CopyText;
  io: Io;
  mac: Mac;
  now?: () => number;
  sleep?: Sleep;
  timeZone?: string;
}
// This Mac: the files of the install and the agent left by the check from this Mac (ADR-0009).
export interface Mac { files: MacFiles; agent: LaunchAgent }
// One of the general rules.
export type Rule = Exclude<keyof Rules, 'formatVersion'>;

// A failure explained to the user in its message.
export class CommandFailed extends Error {}

export const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// The worker of an earlier version on GitHub (ADR-0009): its schedule lives in its repository,
// which only the user can delete. While it is there, two workers run on one quota, so setup and
// uninstall both tell the user to remove it.
export const githubRepoStep = (): string => t('delete the repository codex-auto-resets-worker in your GitHub account ' +
  '(https://github.com/settings/repositories): while it is there, the worker of the earlier version keeps running on its schedule and applying resets',
  'удалите репозиторий codex-auto-resets-worker в своём аккаунте GitHub (https://github.com/settings/repositories): ' +
  'пока он есть, воркер прежней версии продолжает работать по расписанию и применять сбросы');

export const unfinished = (): string => t('Setup is not finished. Run `aures setup`.', 'Установка не завершена. Запустите `aures setup`.');
// The install record names no worker on Google (ADR-0009): there is no install to work with.
export const notInstalled = (): string => t('The worker is not installed. Run `aures setup`.', 'Воркер не установлен. Запустите `aures setup`.');
// The same, on the record this Mac has. A GitHub record of an earlier version adds its
// repository: this is the first thing the user of that version sees after `brew upgrade`
// (`aures`, `status`, `upgrade`), and the worker of that version keeps running while the
// repository is there. files tell the record apart.
export const notInstalledOn = async (files: Pick<MacFiles, 'githubInstall'>): Promise<string> =>
  await files.githubInstall() ? `${notInstalled()}\n${capitalized(githubRepoStep())}` : notInstalled();

// Answers that confirm a one-way action.
export const YES = ['y', 'yes', 'д', 'да'];
export const onOff = (value: boolean): string => value ? t('on', 'включено') : t('off', 'выключено');
export const chatgptLogin = (): string => t('Sign in to ChatGPT for the worker (Codex on this computer is not affected).',
  'Вход в ChatGPT для воркера (Codex на этом компьютере не затронут).');
// What a device-code login tells the user: the page is opened in the browser and the code is
// copied to the clipboard, and both the address and the code are printed too, so a browser or a
// clipboard that does not work leaves the user a way on. Neither failure ends the login: the
// line with the code is printed whatever happens, and the polling goes on. open and copy are
// injected, as the tests do; the mark says the code was copied only when it was.
export const showCode = (io: Printer, open: OpenUrl, copy: CopyText) =>
  async ({ userCode, verificationUrl }: DeviceCode): Promise<void> => {
    let copied = false;
    try { copied = await copy(userCode); } catch { /* the code is printed below anyway */ }
    io.print(t(`Open ${verificationUrl} and enter the code ${userCode}${copied ? ' (code copied)' : ''}`,
      `Откройте ${verificationUrl} и введите код ${userCode}${copied ? ' (код скопирован)' : ''}`));
    io.print(t(`If the browser did not open: ${verificationUrl}`, `Если браузер не открылся: ${verificationUrl}`));
    try { await open(verificationUrl); } catch { /* the address is printed above anyway */ }
  };
export const formatTime = (ms: number, timeZone?: string): string => new Intl.DateTimeFormat(t('en-GB', 'ru-RU'), { day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(ms);

// ─── The stages of setup (issue 30) ────────────────────────────────────────────

// How long a stage waits for the user before its one hint line appears (issue 30): a user
// this quick never sees the buttons or the address, only the stage lines.
export const HINT_AFTER_MS = 30_000;
// How often the wait is looked at. Real ticks, so nothing the CLI itself waits for — the
// browser, the loopback server of a sign-in — is ever starved while the wait is measured.
const HINT_TICK_MS = 50;

// One line a stage shows only when its wait for the user outlasts HINT_AFTER_MS (issue 30).
// The wait itself is measured by the injected now: a test on the fake world moves its clock
// and sees the line after the delay, and never before it. stop() ends the wait — the user
// was quick — and ends it silently.
export interface SlowHint { stop(): void }
export function slowHint(io: Printer, line: string, { now }: { now: () => number }, after = HINT_AFTER_MS): SlowHint {
  let stopped = false;
  (async () => {
    const started = now();
    while (!stopped && now() - started < after) {
      await new Promise(resolve => { setTimeout(resolve, HINT_TICK_MS).unref?.(); });
    }
    if (!stopped) io.print(line);
  })();
  return { stop: () => { stopped = true; } };
}

// The stages of setup (issue 30): each says what it does and why. A stage begins with its
// `[n/N] Name` and one line of why under it; then its steps, each a `✓` line when done, and
// what it needs of the user, a `→` line, all under the indent of the stage. While it works the
// live line stands under the stage too. Whatever the stage prints from deeper down goes through
// its io and keeps the indent.
const INDENT = '      ';
const BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m';
export interface StageRun {
  // The io of the stage: its lines and its waits under the indent.
  io: Io;
  // A step that is done.
  step(text: string): void;
  // What the stage needs the user to do.
  act(text: string): void;
  // The end of the stage, with its last step when it names one.
  done(summary?: string): void;
}
export class Stages {
  private n = 0;
  private readonly io: Io;
  private readonly total: number;
  constructor(io: Io, total: number) {
    this.io = io;
    this.total = total;
  }

  // A stage that runs: its heading, why it is there and, until its first wait, a spinner.
  begin(name: string, why: string): StageRun {
    this.n++;
    const { io } = this, paint = (code: string, text: string) => io.color ? `${code}${text}${RESET}` : text;
    io.print(paint(BOLD, `[${this.n}/${this.total}] ${name}`));
    io.print(paint(DIM, `${INDENT}${why}`));
    const stage: Io = { ...io, print: line => io.print(`${INDENT}${line}`), prompt: question => io.prompt(`${INDENT}${question}`),
      wait: text => io.wait(text === null ? null : `${INDENT}${text}`) };
    stage.wait(t('working…', 'работаем…'));
    return {
      io: stage,
      step: text => stage.print(`✓ ${text}`),
      act: text => stage.print(`→ ${text}`),
      done: summary => {
        stage.wait(null);
        if (summary) stage.print(`✓ ${summary}`);
      },
    };
  }
}

// Why the worker signs in to ChatGPT.
export const chatgptWhy = (): string => t('the worker gets its own ChatGPT session to see and apply your resets',
  'у воркера своя сессия ChatGPT: через неё он видит и применяет сбросы');

// The code of a device login as a stage of setup shows it (issue 30): the code at once as what
// the user does, and the page's address waits with the slow hint — printed only if the user
// takes longer than a moment, for a browser that did not open. ended() is for when the login
// is over, succeeded or not; neither failure of open nor of the clipboard ends it.
export interface StagedCode {
  onCode(code: DeviceCode): Promise<void>;
  ended(): void;
}
export function stagedCode(stage: StageRun, open: OpenUrl, copy: CopyText, now: () => number): StagedCode {
  let hint: SlowHint | null = null;
  return {
    async onCode({ userCode, verificationUrl }) {
      let copied = false;
      try { copied = await copy(userCode); } catch { /* the code is in the line anyway */ }
      stage.act(t(`code ${userCode}${copied ? ' (copied)' : ''}: confirm it in the browser that opened`,
        `код ${userCode}${copied ? ' (скопирован)' : ''}: подтвердите его в открывшемся браузере`));
      stage.io.wait(t('waiting for the confirmation', 'ждём подтверждения'));
      hint?.stop();
      hint = slowHint(stage.io, t(`→ If the browser did not open: ${verificationUrl}`, `→ Если браузер не открылся: ${verificationUrl}`), { now });
      try { await open(verificationUrl); } catch { /* the address comes with the hint */ }
    },
    ended() { hint?.stop(); hint = null; },
  };
}

// What a successful setup ends with (issue 30): one line — the screen it opens next shows
// the resets and the rules themselves. resets is null when the worker has not read them yet,
// with busy telling that ChatGPT was the reason. A worker that is not paused is told to run
// on its own schedule without this Mac.
export function doneLine(resets: number | null, { busy = false, paused = false }: { busy?: boolean; paused?: boolean }): string {
  const told = resets !== null ? t(`Done. Resets: ${resets}.`, `Готово. Сбросов: ${resets}.`) :
    busy ? t('Done. ChatGPT is temporarily unavailable; the worker will read the resets on its next run.',
      'Готово. ChatGPT временно недоступен; воркер прочитает сбросы при следующем запуске.') :
    t('Done. The worker will read the resets on its next run.', 'Готово. Воркер прочитает сбросы при следующем запуске.');
  if (paused) return told;
  return `${told} ${t('The worker runs every 5 minutes on its own, your Mac can be off.',
    'Воркер работает по расписанию каждые 5 минут, Mac можно выключать.')}`;
}

// The two general rules as the user reads them in rules, status and the screen. The
// before-expiry window is one hour, the worker's own (ADR-0009).
export const ruleLabel = (rule: Rule): string => ({
  beforeExpiry: t('Before expiry (in the last hour)', 'Перед истечением (в последний час)'),
  weeklyAutoApply: t('When the weekly limit runs out', 'Когда кончится недельный лимит'),
})[rule];
// Why a reset was applied.
export const reasonText = (reason: ApplyReason): string => ({
  before_expiry: t('before expiry', 'перед истечением'),
  weekly: t('the weekly limit ran out', 'кончился недельный лимит'),
  apply_now: t('manually', 'вручную'),
})[reason] ?? reason;
// lastAttempt.result of an attempt that did not apply the reset.
export const attemptResult = (result: AttemptResult): string => ({
  nothing_to_reset: t('nothing to reset, the reset is kept', 'сбрасывать нечего, сброс сохранён'),
  no_credit: t('ChatGPT did not accept the reset', 'ChatGPT не принял сброс'),
  missing: t('the reset is no longer available', 'сброс уже недоступен'),
  unknown: t('unclear whether it was applied or expired', 'неясно, применён он или истёк'),
} as Partial<Record<AttemptResult, string>>)[result] ?? result;

// How the CLI names a reset: RES and the last 4 characters of its hex ID, the random part.
// «RateLimitResetCredit_0eb466b3212c819193799a1741f067f8» is «RES67F8». An ID of another form is
// shown whole; the worker and its summary keep the whole ID.
export const resetName = (creditId: string): string => {
  const hex = /_([0-9a-f]{8,})$/.exec(creditId)?.[1];
  return hex ? `RES${hex.slice(-4).toUpperCase()}` : creditId;
};
type Expiring = { expiresAt: string | null };
export const deadline = (reset: Expiring, timeZone?: string): string => reset.expiresAt ?
  `${t('expires', 'истекает')} ${formatTime(Date.parse(reset.expiresAt), timeZone)}` : t('no expiry', 'без срока');
export const byDeadline = <T extends Expiring>(resets: T[]): T[] => [...resets].sort((a, b) =>
  (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity));

export async function chooseRules(io: Io, initial: Pick<Rules, Rule> = { beforeExpiry: true, weeklyAutoApply: false }): Promise<Rules> {
  const rules = { beforeExpiry: initial.beforeExpiry, weeklyAutoApply: initial.weeklyAutoApply };
  for (;;) {
    io.print(t('When to apply resets:', 'Когда применять сбросы:'));
    io.print(`  1. ${ruleLabel('beforeExpiry')} — ${onOff(rules.beforeExpiry)}`);
    io.print(`  2. ${ruleLabel('weeklyAutoApply')} — ${onOff(rules.weeklyAutoApply)}`);
    const answer = (await io.prompt(t('Enter — done, 1 or 2 — switch: ', 'Enter — готово, 1 или 2 — переключить: '))).trim();
    if (!answer) return { formatVersion: RULES_FORMAT_VERSION, ...rules };
    if (answer === '1') rules.beforeExpiry = !rules.beforeExpiry;
    else if (answer === '2') rules.weeklyAutoApply = !rules.weeklyAutoApply;
    else io.print(t('Type 1 or 2, or press Enter.', 'Введите 1, 2 или нажмите Enter.'));
  }
}

// The line that tells the user the worker works, from its summary.
export function workingLine(summary: Summary, timeZone?: string): string {
  const resets = summary.resets ?? [];
  const deadlines = resets.map(r => r.expiresAt && Date.parse(r.expiresAt)).filter((ms): ms is number => Boolean(ms)).sort((a, b) => a - b);
  const nearest = deadlines[0];
  if (nearest === undefined) return t(`The worker works. Resets: ${resets.length}.`, `Воркер работает. Сбросов: ${resets.length}.`);
  return t(`The worker works. Resets: ${resets.length}, the nearest expires ${formatTime(nearest, timeZone)}.`,
    `Воркер работает. Сбросов: ${resets.length}, ближайший истекает ${formatTime(nearest, timeZone)}.`);
}

// What the rules would do now, by a trial run's outcome; nothing for another outcome.
export function trialVerdict({ outcome, wouldApply }: { outcome: RunOutcome; wouldApply?: WouldApply }): string | null {
  if (wouldApply) {
    const name = resetName(wouldApply.creditId), why = reasonText(wouldApply.reason);
    return t(`Now the rules would apply the reset ${name} (${why}).`, `Сейчас правила применили бы сброс ${name} (${why}).`);
  }
  return outcome === 'idle' ? t('Nothing to apply now.', 'Сейчас применять нечего.') : null;
}
// A trial run before the worker's first successful read; busy: ChatGPT did not answer it.
export const notReadYet = (busy: boolean): string =>
  t(`The worker is installed, but the resets are not read yet${busy ? ': ChatGPT is temporarily unavailable' : ''}. ` +
    'The worker will try again on its next run.',
  `Воркер установлен, но сбросы пока не прочитаны${busy ? ': ChatGPT временно недоступен' : ''}. Воркер повторит при следующем запуске.`);

// What the user does about a failed run of the worker.
export function failedRunAdvice({ outcome }: { outcome?: RunOutcome }): string {
  const advice: Partial<Record<RunOutcome, string>> = {
    reauth_required: t('The worker lost its ChatGPT sign-in. Sign in again: `aures login`.',
      'Воркер потерял вход в ChatGPT. Войдите заново: `aures login`.'),
  };
  return (outcome && advice[outcome]) ?? t('The worker ended with an error.', 'Воркер завершился с ошибкой.');
}

// The message for a failure this module knows, or null. command names what to repeat: '' is
// the screen itself, null an action on the screen, which the user just repeats.
export function explain(error: unknown, command: string | null = null): string | null {
  if (error instanceof CommandFailed) return error.message;
  const program = `\`aures${command ? ` ${command}` : ''}\``;
  const again = command === null ? t('Try again', 'Повторите') : t(`Run ${program} again`, `Повторите ${program}`);
  const kept = t('what is done is kept', 'сделанное сохранится');
  if (error instanceof GoogleFailure) {
    return ({
      invalid_grant: t(`Google ended the sign-in. ${again} and sign in anew.`, `Google завершил вход. ${again} и войдите заново.`),
      unauthorized: t(`Google rejected the sign-in. ${again} and sign in anew.`, `Google отклонил вход. ${again} и войдите заново.`),
      network: t(`Google is unreachable. ${again}: ${kept}.`, `Google недоступен. ${again}: ${kept}.`),
      login_timeout: t(`The time to sign in to Google ran out. ${again}.`, `Время на вход в Google вышло. ${again}.`),
      login_denied: t('The Google sign-in was denied.', 'Вход в Google отклонён.'),
    } as Partial<Record<GoogleFailureReason, string>>)[error.reason] ?? t(`Google error (${error.reason}). ${again}: ${kept}.`, `Ошибка Google (${error.reason}). ${again}: ${kept}.`);
  }
  if (error instanceof LoginFailed) {
    return error.reason === 'timeout' ? t(`The time to enter the ChatGPT code ran out. ${again}.`, `Время на ввод кода ChatGPT вышло. ${again}.`) :
      t(`Could not sign in to ChatGPT (${error.reason}). ${again}.`, `Не удалось войти в ChatGPT (${error.reason}). ${again}.`);
  }
  if (error instanceof TransientFailure) return t(`ChatGPT is unreachable. ${again}: ${kept}.`, `ChatGPT недоступен. ${again}: ${kept}.`);
  return null;
}

// Runs a command body and turns known failures into their message and exit code 1. name is the
// command to repeat after a failure; null an action on the screen, which the user just repeats.
export async function command(name: string | null, io: Printer, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    const message = explain(error, name);
    if (message === null) throw error;
    for (const line of message.split('\n')) io.print(line);
    return 1;
  }
}
