// The screen «Воркер» (CONTEXT.md; Tab from the overview of the resets): the platform and its
// state, the accounts with «войти заново», the actions in one row with the caption of the one
// the cursor stands on, and the live journal — when a run started, who started it and what it
// came to — in a window of its own, as tall as the screen of the resets. The page keeps what it
// read and is worded when drawn, as the overview, so the language changes on the spot.
import type { Platform, Accounts, Switching } from './watch-files.ts';
import { readJournal } from './journal.ts';
import type { Journal, JournalEntry, JournalKind } from './journal.ts';
import { projectUrl } from './active-worker.ts';
import type { Worker } from './active-worker.ts';
import type { Mac } from './mac-check.ts';
import { resetName, reasonText } from './common.ts';
import { otherPlatform, platformName } from './switch.ts';
import { shortTime, S, WIDTH } from './overview.ts';
import type { Segment, Tone } from './overview.ts';
import type { Summary } from '../worker/summary.ts';
import { fit } from './fit.ts';
import { t } from './language.ts';
import { GoogleApi, GoogleFailure } from '../google/api.ts';
import type { Fetch } from '../chatgpt/http.ts';
import { KeychainUnavailable } from './keychain.ts';
import type { Keychain } from './keychain.ts';

// While the screen is open the worker is polled this often: Google answers in a second, GitHub
// counts every listing against its API limit.
export const POLL_MS: Record<Platform, number> = { google: 30_000, github: 60_000 };
const TONES: Record<Tone, string> = { ok: S.green, warn: S.yellow, bad: S.red };
// The lines of the screen besides its journal window: the header with its rule and the blank
// under them, the bracket of the section «ВОРКЕР» without a caption, the blank between the
// sections and the heading and the corner of the journal. An unfinished switch adds one more,
// which the height may take; an open caption adds as many as its text needs.
const FIXED_LINES = 14;

// The rows of the journal window: the body of the screen «Воркер» is as tall as the body of the
// overview (target, its line count; null before the overview is read), with the window 3–10 rows.
export const journalHeight = (target: number | null): number =>
  target === null ? 6 : Math.max(3, Math.min(10, target - FIXED_LINES));

// A step of the CLI on this screen, which the journal shows among the runs.
export interface Step { at: number; text: string; tone: Tone }
// What the screen read: the record of this Mac and the journal of the worker, or why the last
// poll did not get it.
export interface WorkerPage {
  platform: Platform;
  link: string;
  paused: boolean;
  // A switch of platform that has not finished: no worker is active (ADR-0007).
  switching: Switching | null;
  // The GitHub login; on Google, the email of the Google account if a sign-in gave it.
  account: string | null;
  accounts: Accounts;
  // Whether Google still takes the sign-in of the CLI: false when it is gone (revoked or expired)
  // or there is none; null on GitHub, or when the Keychain or Google did not answer.
  googleSignIn: boolean | null;
  journal: Journal | null;
  polledAt: number;
  failed: string | null;
}

export interface WorkerPageOptions { worker: Worker; mac: Mac; now: () => number; fetch: Fetch; googleKeychain: Pick<Keychain, 'read'> }
export async function readWorkerPage({ worker, mac, now, fetch, googleKeychain }: WorkerPageOptions): Promise<WorkerPage> {
  const install = await mac.files.readInstall();
  const accounts = install?.accounts ?? {};
  const page = { platform: worker.platform, paused: install?.paused === true, switching: install?.switching ?? null, accounts,
    link: worker.platform === 'github' ? worker.repo.html_url : projectUrl(worker.scriptId),
    account: worker.platform === 'github' ? worker.repo.owner.login : accounts.google ?? null };
  const [journal, googleSignIn] = await Promise.all([readJournal(worker, { now }),
    worker.platform === 'google' ? checkGoogleSignIn({ fetch, now, keychain: googleKeychain }) : null]);
  return { ...page, googleSignIn, journal, polledAt: now(), failed: null };
}

// The worker on Google runs without the sign-in of the CLI, so nothing in its journal tells of
// it: the poll asks Google for an access token with the refresh token from the Keychain.
async function checkGoogleSignIn({ fetch, now, keychain }: { fetch: Fetch; now: () => number; keychain: Pick<Keychain, 'read'> }):
  Promise<boolean | null> {
  let token: string | null;
  try { token = await keychain.read(); } catch (error) { if (error instanceof KeychainUnavailable) return null; throw error; }
  if (!token) return false;
  try {
    await new GoogleApi({ fetch, now, refreshToken: token }).accessToken();
    return true;
  } catch (error) { return error instanceof GoogleFailure && error.reason === 'invalid_grant' ? false : null; }
}

// The cursor stands on the accounts, then on the actions; it opens on the first action. A worker
// on pause is not switched from: it is taken off pause first. While a switch is unfinished the
// only action is to finish it: everything else would run or schedule a worker that is not active.
export type WorkerItem = 'platformAccount' | 'chatgpt' | 'trial' | 'repair' | 'pause' | 'switch' | 'retry';
const ACCOUNT_ITEMS: WorkerItem[] = ['platformAccount', 'chatgpt'];
export const workerItems = ({ paused, switching }: Pick<WorkerPage, 'paused' | 'switching'>): WorkerItem[] => [...ACCOUNT_ITEMS,
  ...switching ? ['retry' as const] : paused ? ['trial', 'repair', 'pause'] as const : ['trial', 'repair', 'pause', 'switch'] as const];
export const FIRST_ACTION = ACCOUNT_ITEMS.length;

export { platformName };
export const itemLabel = (item: WorkerItem, platform: Platform, paused: boolean): string => ({
  platformAccount: platform === 'github' ? 'GitHub' : 'Google',
  chatgpt: 'ChatGPT',
  trial: t('Check now', 'Проверить сейчас'),
  repair: t('Repair', 'Починить'),
  // The one of the two pause actions that applies to the state the page read.
  pause: paused ? t('Unpause', 'Снять с паузы') : t('Pause', 'Пауза'),
  switch: t(`Switch to ${platformName(otherPlatform(platform))}`, `Переключиться на ${platformName(otherPlatform(platform))}`),
  retry: t('Retry the switch', 'Повторить переключение'),
})[item];
export const repairCaption = (): string => t('Deploy the current version of the worker again and bring its schedule back on this platform. ' +
  'The resets, the rules, the ChatGPT sign-in and the journal are not touched. Helps when the worker stopped running or its files were ' +
  'changed by hand',
'Заново залить текущую версию воркера и вернуть расписание на этой площадке. Сбросы, правила, вход в ChatGPT и журнал не трогаются. ' +
  'Поможет, если воркер перестал запускаться или его файлы меняли вручную');

export const switchCaption = (platform: Platform): string => t(`The worker on ${platformName(otherPlatform(platform))} is prepared ` +
  'without a schedule while this one keeps working: you sign it in to ChatGPT, the rules move with it. Then this worker is quenched ' +
  '(its schedule off, its ChatGPT session revoked, the ' + (platform === 'github' ? 'repository' : 'project') + ' kept) and the new one gets ' +
  'its schedule. Esc stops the switch until the quench and leaves this worker as it is',
`Воркер на ${platformName(otherPlatform(platform))} готовится без расписания, пока этот работает: вы входите для него в ChatGPT, ` +
  'правила переезжают с ним. Затем этот воркер гасится (расписание снято, сессия ChatGPT отозвана, ' +
  (platform === 'github' ? 'репозиторий' : 'проект') + ' сохранён), и у нового включается расписание. Esc до гашения отменяет ' +
  'переключение и оставляет этот воркер как есть');

export const trialCaption = (platform: Platform): string => t('A trial run: the worker reads the limits and the resets and shows what ' +
  'the rules would do. Applies nothing.' + (platform === 'github' ? ' On GitHub it takes about a minute.' : ''),
'Пробный запуск: воркер читает квоты и сбросы и показывает, что сделали бы правила. Ничего не применяет.' +
  (platform === 'github' ? ' На GitHub — около минуты.' : ''));
export const pauseCaption = (): string => t('Turn the schedule off: the rules stop applying resets, each burns at its deadline. ' +
  '«Apply now» still works.',
'Снять расписание: правила перестают применять сбросы, каждый сгорит в свой срок. «Применить сейчас» продолжает работать.');
export const unpauseCaption = (): string => t('Turn the schedule back on: the worker applies resets by the rules again.',
  'Вернуть расписание: воркер снова применяет сбросы по правилам.');
export const retryCaption = (): string => t('Finish the switch: the new worker gets its schedule, the old one is quenched. Until it is ' +
  'finished no worker is active and resets are not applied.',
'Довести переключение до конца: новый воркер получает расписание, прежний гасится. Пока оно не завершено, активного воркера нет и ' +
  'сбросы не применяются.');

// The caption of an action of the row (issue 03): every one of them has one.
export const itemCaption = (item: Exclude<WorkerItem, 'platformAccount' | 'chatgpt'>, platform: Platform, paused: boolean): string =>
  ({ trial: trialCaption(platform), repair: repairCaption(), pause: paused ? unpauseCaption() : pauseCaption(),
    switch: switchCaption(platform), retry: retryCaption() })[item];

// The caption of an action folded to lines no longer than width: what it does up front, in the
// plain colour, and the details after, dim.
function captionLines(text: string, width: number): Segment[][] {
  const cut = text.indexOf('. ') + 1 || text.indexOf(': ') + 1 || text.length;
  const words: [string, string][] = [
    ...text.slice(0, cut).split(' ').filter(Boolean).map(word => [word, ''] as [string, string]),
    ...text.slice(cut).split(' ').filter(Boolean).map(word => [word, S.dim] as [string, string]),
  ];
  const rows: { text: string; style: string }[][] = [[]];
  let used = 0;
  for (const [word, style] of words) {
    if (used && used + 1 + len(word) > width) { rows.push([]); used = 0; }
    rows[rows.length - 1]?.push({ text: (used ? ' ' : '') + word, style });
    used += (used ? 1 : 0) + len(word);
  }
  return rows.map(row => row.reduce<Segment[]>((out, part) => {
    const last = out[out.length - 1];
    if (last && last[1] === part.style) last[0] += part.text;
    else out.push([part.text, part.style]);
    return out;
  }, []));
}

// The worker in the heading of its section: the label beside the dot on the right, the detail as
// the first line of the section when the state has one (issue 03).
function pageState({ paused, switching }: Pick<WorkerPage, 'paused' | 'switching'>): { tone: Tone; label: string; detail: string | null } {
  if (switching) return { tone: 'bad', label: t('no active worker', 'нет активного воркера'),
    detail: t('the switch is not finished', 'переключение не завершено') };
  if (paused) return { tone: 'warn', label: t('paused', 'на паузе'), detail: null };
  return { tone: 'ok', label: t('active', 'активен'), detail: null };
}

// «1 проверка, 3 проверки, 5 проверок, 21 проверка» — the Russian word by the count.
const checksWord = (n: number): string => {
  const ones = n % 10, hundreds = n % 100;
  return hundreds >= 5 && hundreds <= 20 || ones > 4 || ones === 0 ? 'проверок' : ones === 1 ? 'проверка' : 'проверки';
};
const checks = (n: number): string => t(`${n} ${n === 1 ? 'check' : 'checks'}`, `${n} ${checksWord(n)}`);

// «2,1 с» / «2.1 s».
const seconds = (ms: number): string =>
  `${new Intl.NumberFormat(t('en-GB', 'ru-RU'), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ms / 1000)} ${t('s', 'с')}`;
// «12:04:31» in the user's time zone.
const clock = (ms: number, timeZone?: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit',
  second: '2-digit', hourCycle: 'h23', timeZone }).format(ms);
// «12:04» in the user's time zone.
const hourClock = (ms: number, timeZone?: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZone }).format(ms);
const dayOf = (ms: number, timeZone?: string): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric',
  year: 'numeric', timeZone }).format(ms);
// «12:04» for a run of today, «22 Oct 15:00» for one of another day, in the user's time zone.
const dayTime = (ms: number, timeZone: string | undefined, now: () => number): string =>
  dayOf(ms, timeZone) === dayOf(now(), timeZone) ? hourClock(ms, timeZone) : shortTime(ms, timeZone);

// The worker session is lost when the latest run that got an answer from ChatGPT says so.
const sessionLost = (entries: JournalEntry[]): boolean =>
  entries.findLast(entry => entry.outcome !== null && entry.outcome !== 'transient_error')?.outcome === 'reauth_required';

const len = (text: string): number => [...text].length;
const spread = (left: Segment[], right: Segment[], width: number): Segment[] => {
  const used = [...left, ...right].reduce((n, [text]) => n + len(text), 0);
  return [...left, [' '.repeat(Math.max(3, width - used)), ''], ...right];
};

// The applied reset the summary names for a run: the journal entry itself says only that a reset
// was applied, so the name and the reason come from the application of that moment (issue 03).
function appliedName(entry: JournalEntry, lastApplied: Summary['lastApplied']): string | null {
  if (!lastApplied) return null;
  const at = Date.parse(entry.at), appliedAt = Date.parse(lastApplied.at);
  return at <= appliedAt && appliedAt <= at + entry.durationMs + 60_000 ?
    `${resetName(lastApplied.creditId)} — ${reasonText(lastApplied.reason)}` : null;
}

// What a run came to, in the tone it deserves: what needs the user in red, what waits in yellow,
// an application in green, a run still going on dim.
function outcomeOf(entry: JournalEntry, lastApplied: Summary['lastApplied']): [string, string] {
  const { outcome, reason, wouldApply } = entry;
  if (outcome === 'applied') {
    const named = appliedName(entry, lastApplied);
    return [named ? t(`applied ${named}`, `применён ${named}`) : t('a reset applied', 'сброс применён'), S.green];
  }
  if (outcome === 'would_apply') {
    return [wouldApply ? t(`would apply ${resetName(wouldApply.creditId)} — ${reasonText(wouldApply.reason)}`,
      `применили бы ${resetName(wouldApply.creditId)} — ${reasonText(wouldApply.reason)}`) :
      t('would apply a reset', 'применили бы сброс'), ''];
  }
  const byOutcome: Record<string, [string, string]> = {
    pending: [t('sent, waiting for ChatGPT to confirm', 'отправлен, ждём подтверждения ChatGPT'), ''],
    transient_error: [t('ChatGPT did not answer — retry on the next run', 'ChatGPT не ответил — повтор при следующем запуске'), S.yellow],
    reauth_required: [t('lost the ChatGPT sign-in — sign in again', 'потерян вход в ChatGPT — нужен новый вход'), S.red],
    broken_state: [t(`the data does not read (${reason})`, `данные не читаются (${reason})`), S.red],
    commit_failed: [t('could not save the data', 'не удалось сохранить данные'), S.red],
    revoked: [t('sign-in revoked', 'вход отозван'), ''],
    revoke_failed: [t('the revocation is not confirmed', 'отзыв входа не подтверждён'), S.yellow],
  };
  if (outcome === null) return [t('running…', 'идёт…'), S.dim];
  if (outcome === 'idle') return [entry.kind === 'scheduled' ? t('all fine, nothing to apply', 'всё в порядке, применять нечего') :
    entry.kind === 'login' ? t('the worker session is renewed', 'сессия воркера обновлена') :
    t('nothing to apply', 'применять нечего'), ''];
  return byOutcome[outcome] ?? [outcome, ''];
}

// Who started a run and what it came to: the schedule, the Mac of the weekly check or you — a
// trial run, an «Apply now», a sign-in, a step of the CLI. What a run came to names what started
// it up front, joined with a dash — or a colon, when the outcome has a dash of its own.
function entryLine(entry: JournalEntry, lastApplied: Summary['lastApplied']): { who: string; you: boolean; text: string; tone: string } {
  const start = ({
    trial: t('trial check', 'пробная проверка'),
    apply_now: t('«Apply now»', '«Применить сейчас»'),
    login: t('ChatGPT sign-in', 'вход в ChatGPT'),
    mac: t('the weekly limit ran out', 'кончился недельный лимит'),
    scheduled: null,
  } as Record<JournalKind, string | null>)[entry.kind] ?? null;
  const [outcome, tone] = outcomeOf(entry, lastApplied);
  return {
    who: entry.kind === 'scheduled' ? t('schedule', 'расписание') : entry.kind === 'mac' ? 'Mac' : t('you', 'вы'),
    you: entry.kind !== 'scheduled' && entry.kind !== 'mac',
    text: start === null ? outcome : outcome.includes(' — ') ? `${start}: ${outcome}` : `${start} — ${outcome}`,
    tone,
  };
}

// One row of the journal window before folding: a run of the worker, a few of them in a row with
// the same kind and a quiet outcome collapsed into one (from is then their oldest time), or a
// step of the CLI.
interface JournalRow { from: number; at: number; count: number; who: string; you: boolean; text: string; tone: string }

// The runs and the steps as rows, newest first. Only the quiet outcomes collapse — what needs
// the user stays said — and a step of the CLI between them breaks the run.
function journalRows(entries: JournalEntry[], steps: Step[], lastApplied: Summary['lastApplied']): JournalRow[] {
  const quiet = (outcome: JournalEntry['outcome']): boolean => outcome === 'idle' || outcome === 'transient_error';
  const both: { at: number; i: number; entry?: JournalEntry; step?: Step }[] =
    [...entries.map(entry => ({ at: Date.parse(entry.at), entry })), ...steps.map(step => ({ at: step.at, step }))]
      .map((row, i) => ({ ...row, i })).sort((a, b) => a.at - b.at || a.i - b.i).reverse();
  const rows: JournalRow[] = [];
  for (let i = 0; i < both.length;) {
    const row = both[i];
    if (!row) break;
    const { at } = row, step = row.step, entry = row.entry;
    if (step !== undefined || entry === undefined) {
      rows.push({ from: at, at, count: 1, who: t('you', 'вы'), you: true, text: step?.text ?? '',
        tone: step?.tone === 'warn' ? S.yellow : S.dim });
      i++;
      continue;
    }
    let n = 1;
    while (n < both.length - i) {
      const next = both[i + n]?.entry;
      if (!next || next.kind !== entry.kind || !quiet(entry.outcome) || !quiet(next.outcome) || next.outcome !== entry.outcome) break;
      n++;
    }
    const line = entryLine(entry, lastApplied);
    // The count of a collapsed row: the schedule says it in checks, the other kinds count their lines.
    rows.push(n === 1 ? { from: at, at, count: 1, ...line } : { from: both[i + n - 1]?.at ?? at, at, count: n, ...line,
      text: entry.kind === 'scheduled' ? `${checks(n)} — ${line.text}` : `${line.text} ×${n}` });
    i += n;
  }
  return rows;
}

// The journal window of the page: every visual line it can scroll over, newest first, folded to
// two columns short of the width — the rail of its bracket stands before them (issue 03). The
// window counts and scrolls in these visual lines, whatever a long line folds into.
export interface JournalWindowOptions { timeZone?: string; width?: number; now: () => number; lastApplied?: Summary['lastApplied'] }
export function journalWindow(page: WorkerPage, steps: Step[], { timeZone, width = WIDTH, now, lastApplied = null }: JournalWindowOptions):
  Segment[][] {
  const rows = journalRows(page.journal?.entries ?? [], steps, lastApplied);
  const labels = rows.map(row => row.count > 1 ? `${dayTime(row.from, timeZone, now)}–${dayTime(row.at, timeZone, now)}` :
    dayTime(row.at, timeZone, now));
  const timeWidth = Math.max(0, ...labels.map(label => len(label)));
  const whoWidth = Math.max(0, ...rows.map(row => len(row.who)));
  // Three columns: when, who and what came of it; the rest of a long line folds under the last.
  return rows.flatMap((row, i) => fit(
    [[(labels[i] ?? '').padEnd(timeWidth + 2), S.dim], [row.who.padEnd(whoWidth + 2), row.you ? S.cyan : S.dim], [row.text, row.tone]],
    width - 2));
}

// header is the top line, the same as on the overview. rows is the height of the journal window
// (journalHeight), offset how far it is scrolled in visual lines, focus whether the cursor stands
// in the journal, caption whether the caption of the action under the cursor is open, lastApplied
// the application the summary names for the journal. now tells today, for the time of a run.
export interface WorkerRenderOptions { timeZone?: string; width?: number; cursor: number; steps: Step[]; header: Segment[];
  now: () => number; rows: number; offset?: number; focus?: boolean; caption?: boolean; lastApplied?: Summary['lastApplied'] }
export function renderWorker(page: WorkerPage, { timeZone, width = WIDTH, cursor, steps, header, now, rows, offset = 0,
  focus = false, caption = false, lastApplied = null }: WorkerRenderOptions): Segment[][] {
  const lines: Segment[][] = [header, [['─'.repeat(width), S.dim]], []];
  const items = workerItems(page);
  const selected = (item: WorkerItem) => items[cursor] === item;
  // With the cursor in the journal neither the accounts nor the row of actions point anywhere.
  const chosen = (item: WorkerItem): boolean => !focus && selected(item);
  const rail = (on = false): Segment => [on ? '┃ ' : '│ ', on ? S.cyan : S.dim];

  // The section «ВОРКЕР»: the state on the right of the heading, the link, the accounts and the
  // actions in one row, the caption of the action under the cursor, all in one bracket.
  const state = pageState(page);
  lines.push(spread([['╭─ ', S.dim], [t('WORKER', 'ВОРКЕР'), S.bold], [` · ${platformName(page.platform)}`, S.dim]],
    [['● ', TONES[state.tone]], [state.label, TONES[state.tone]]], width));
  if (state.detail) lines.push([rail(), [state.detail, TONES[state.tone]]]);
  lines.push([rail(), [page.link, S.dim]], [['│', S.dim]]);

  const entries = page.journal?.entries ?? [];
  const unknown = t('account unknown', 'аккаунт неизвестен');
  const signIn = (lost: boolean): Segment[] => [[' · ', S.dim],
    lost ? [t('sign-in lost', 'вход потерян'), S.yellow] : [t('signed in', 'вход работает'), '']];
  const accounts: [WorkerItem, Segment[]][] = [
    ['platformAccount', [[page.account ?? unknown, page.account ? '' : S.dim],
      ...page.googleSignIn === null ? [] : signIn(!page.googleSignIn)]],
    ['chatgpt', [[page.accounts.chatgpt ?? unknown, page.accounts.chatgpt ? '' : S.dim], ...signIn(sessionLost(entries))]],
  ];
  const labelWidth = Math.max(...accounts.map(([item]) => len(itemLabel(item, page.platform, page.paused)))) + 3;
  for (const [item, value] of accounts) {
    const on = chosen(item);
    lines.push(spread([rail(on), [itemLabel(item, page.platform, page.paused).padEnd(labelWidth), on ? S.cyan : ''], ...value],
      [[t('sign in again', 'войти заново'), on ? S.cyan : S.dim]], width));
  }
  lines.push([['│', S.dim]]);

  // The actions in one row: three spaces between the labels — two when the row does not fit —
  // the chosen one in cyan, the rail heavy while the cursor walks the row.
  const actions = items.slice(FIRST_ACTION);
  const labels = actions.map(item => itemLabel(item, page.platform, page.paused));
  const gap = 2 + labels.reduce((n, label) => n + len(label), 0) + 3 * (labels.length - 1) <= width ? '   ' : '  ';
  const starts: number[] = [];
  const row: Segment[] = [];
  for (const [i, item] of actions.entries()) {
    if (i) row.push([gap, '']);
    starts.push(2 + row.reduce((n, [text]) => n + len(text), 0));
    row.push([labels[i] ?? '', chosen(item) ? S.cyan : '']);
  }
  lines.push([rail(!focus && cursor >= FIRST_ACTION), ...row]);

  // The caption of the action under the cursor, when it is open: a rule under its label, then
  // what it does and the details of that, folded to the width. The journal moves under it.
  const item = items[cursor];
  if (caption && !focus && item !== undefined && item !== 'platformAccount' && item !== 'chatgpt') {
    const at = cursor - FIRST_ACTION, label = labels[at] ?? '';
    lines.push([rail(), [' '.repeat(Math.max(0, (starts[at] ?? 2) - 2)), ''], ['━'.repeat(len(label)), S.cyan]]);
    for (const line of captionLines(itemCaption(item, page.platform, page.paused), width - 4))
      lines.push([rail(), ['  ', ''], ...line]);
  }
  lines.push([['╰─', S.dim]], []);

  // The section «ЖУРНАЛ»: the poll on the right of its heading, its window on the rail — the
  // rail is the scroll bar, heavy where the window stands on its lines, cyan in the focus. A
  // poll that got no answer pins its reason over the first row of the window.
  const polled = clock(page.polledAt, timeZone);
  const poll: Segment[] = page.failed ? [[t(`no answer · ${polled}`, `воркер не ответил · ${polled}`), S.yellow]]
    : page.journal ? [[t(`updated ${polled} · answer ${seconds(page.journal.responseMs)}`,
      `обновлено ${polled} · ответ ${seconds(page.journal.responseMs)}`), S.dim]] : [];
  const viewport = rows - (page.failed ? 1 : 0);
  const visual = journalWindow(page, steps, { timeZone, width, now, lastApplied });
  const total = visual.length;
  const shown = Math.min(offset, Math.max(0, total - viewport));
  const range = (focus || shown > 0) && total ?
    ` · ${shown + 1}–${Math.min(shown + viewport, total)} ${t('of', 'из')} ${total}` : '';
  lines.push(poll.length ? spread([['╭─ ', focus ? S.cyan : S.dim], [t('JOURNAL', 'ЖУРНАЛ'), S.bold], [range, S.dim]], poll, width) :
    [['╭─ ', focus ? S.cyan : S.dim], [t('JOURNAL', 'ЖУРНАЛ'), S.bold], [range, S.dim]]);

  const thumb = total > viewport ? Math.max(1, Math.round(rows * viewport / total)) : 0;
  const top = Math.min(rows - thumb, Math.round(shown / Math.max(1, total - viewport) * (rows - thumb)));
  // The rail of a window row: heavy (┃) where the thumb stands over it; the reason a poll that
  // got no answer pins over the window takes its first row.
  const bar = (i: number): Segment => thumb && i >= top && i < top + thumb ? ['┃ ', focus ? S.cyan : ''] : ['│ ', S.dim];
  const window: Segment[][] = [];
  if (page.failed) {
    const reason = page.failed, room = width - 2;
    window.push([bar(0), [len(reason) <= room ? reason : `${[...reason].slice(0, room - 1).join('')}…`, S.yellow]]);
  }
  if (!total && page.journal) window.push([bar(window.length), [t('no runs yet', 'запусков ещё нет'), S.dim]]);
  window.push(...visual.slice(shown, shown + viewport).map((line, i): Segment[] => [bar(i + window.length), ...line]));
  while (window.length < rows) window.push([['│', S.dim]]);
  lines.push(...window, [['╰─', focus ? S.cyan : S.dim]]);
  return lines;
}
