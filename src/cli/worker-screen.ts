// The screen «Воркер» (CONTEXT.md; Tab from the overview of the resets): the platform and its
// state, the accounts with «войти заново», the actions in one row and the live journal in a
// window of its own, as tall as the screen of the resets. The page keeps what it read and is
// worded when drawn, as the overview, so the language changes on the spot.
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
// The lines of the screen besides its journal window: the header and the blank under it, the
// heading «ВОРКЕР» with its line, the link, the two accounts, the row of actions and the heading
// «ЖУРНАЛ» with its line. An unfinished switch adds one more, which the height may take.
const FIXED_LINES = 13;

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

const KINDS = (): Record<JournalKind, string> => ({
  scheduled: t('scheduled', 'по расписанию'), mac: t('from the Mac', 'с Mac'), trial: t('trial', 'пробный'),
  apply_now: t('apply now', 'применить сейчас'), login: t('sign-in', 'вход'),
});
function outcomeText({ outcome, reason, wouldApply }: JournalEntry): string {
  if (outcome === 'would_apply') {
    return wouldApply ? t(`would apply ${resetName(wouldApply.creditId)} (${reasonText(wouldApply.reason)})`,
      `применили бы ${resetName(wouldApply.creditId)} (${reasonText(wouldApply.reason)})`) : t('would apply a reset', 'применили бы сброс');
  }
  return ({
    idle: t('nothing to apply', 'применять нечего'),
    applied: t('reset applied', 'сброс применён'),
    pending: t('the outcome of the application is not known yet', 'исход применения ещё неизвестен'),
    transient_error: t('temporary error', 'временная ошибка'),
    reauth_required: t('lost the ChatGPT sign-in', 'потерян вход в ChatGPT'),
    broken_state: t(`the data does not read (${reason})`, `данные не читаются (${reason})`),
    commit_failed: t('could not save the data', 'не удалось сохранить данные'),
    revoked: t('sign-in revoked', 'вход отозван'),
    revoke_failed: t('the revocation is not confirmed', 'отзыв входа не подтверждён'),
  } as Record<string, string>)[outcome ?? ''] ?? (outcome === null ? t('running…', 'идёт…') : outcome);
}
const BAD: JournalEntry['outcome'][] = ['reauth_required', 'broken_state', 'commit_failed'];

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

// Words of a line up to width each, for the caption.
const wrap = (text: string, width: number): string[] => text.split(' ').reduce<string[]>((lines, word) => {
  const last = lines.at(-1);
  if (last !== undefined && [...`${last} ${word}`].length <= width) lines[lines.length - 1] = `${last} ${word}`;
  else lines.push(word);
  return lines;
}, []);
const len = (text: string): number => [...text].length;
const spread = (left: Segment[], right: Segment[], width: number): Segment[] => {
  const used = [...left, ...right].reduce((n, [text]) => n + len(text), 0);
  return [...left, [' '.repeat(Math.max(3, width - used)), ''], ...right];
};

// One row of the journal window before folding: a run of the worker, a few of them in a row with
// the same kind and outcome collapsed into one (from is then their oldest time), or a step of the
// CLI. note is what stands on the right: the duration of one run, or the count of many.
interface JournalRow { from: number; at: number; count: number; text: string; tone: string; note: string | null }

// The runs and the steps as rows, newest first, with runs of the same kind and outcome in a row
// collapsed into one; a step of the CLI between them breaks the run, and a bad outcome never
// collapses, so that what needs the user stays said.
function journalRows(entries: JournalEntry[], steps: Step[]): JournalRow[] {
  const kinds = KINDS();
  const both: { at: number; i: number; entry?: JournalEntry; step?: Step }[] =
    [...entries.map(entry => ({ at: Date.parse(entry.at), entry })), ...steps.map(step => ({ at: step.at, step }))]
      .map((row, i) => ({ ...row, i })).sort((a, b) => a.at - b.at || a.i - b.i).reverse();
  const rows: JournalRow[] = [];
  for (let i = 0; i < both.length;) {
    const row = both[i];
    if (!row) break;
    const { at } = row, entry = row.entry, step = row.step;
    if (step !== undefined || entry === undefined) {
      rows.push({ from: at, at, count: 1, text: `aures · ${step?.text ?? ''}`,
        tone: !step || step.tone === 'ok' ? '' : TONES[step.tone], note: null });
      i++;
      continue;
    }
    let n = 1;
    while (n < both.length - i) {
      const next = both[i + n]?.entry;
      if (!next || next.kind !== entry.kind || BAD.includes(next.outcome) || outcomeText(next) !== outcomeText(entry)) break;
      n++;
    }
    rows.push(n === 1
      ? { from: at, at, count: 1, text: `${kinds[entry.kind] ?? entry.kind} · ${outcomeText(entry)}`,
        tone: BAD.includes(entry.outcome) ? TONES.bad : '', note: seconds(entry.durationMs) }
      : { from: both[i + n - 1]?.at ?? at, at, count: n, text: `${kinds[entry.kind] ?? entry.kind} · ${outcomeText(entry)}`, tone: '', note: `×${n}` });
    i += n;
  }
  return rows;
}

// The journal window of the page: every visual line it can scroll over, newest first, folded to
// the width its text has — 3 columns short of the frame when a scroll bar stands beside it. The
// window counts and scrolls in these visual lines, whatever a long line folds into.
export interface JournalWindowOptions { timeZone?: string; width?: number; now: () => number; viewport: number }
export function journalWindow(page: WorkerPage, steps: Step[], { timeZone, width = WIDTH, now, viewport }: JournalWindowOptions):
  { lines: Segment[][]; bar: boolean } {
  const rows = journalRows(page.journal?.entries ?? [], steps);
  const labels = rows.map(row => row.count > 1 ? `${dayTime(row.from, timeZone, now)}–${dayTime(row.at, timeZone, now)}` :
    dayTime(row.at, timeZone, now));
  const timeWidth = Math.max(0, ...labels.map(label => len(label)));
  // The duration or the count stands on the right edge of the row; of a row too long to hold it,
  // on the end of its text, where folding takes it.
  const toLines = (room: number): Segment[][] => rows.flatMap((row, i) => {
    const line: Segment[] = [[`  ${(labels[i] ?? '').padEnd(timeWidth)}  `, S.dim], [row.text, row.tone]];
    if (row.note !== null) {
      const note: Segment = [row.note, S.dim];
      const used = 2 + timeWidth + 2 + len(row.text) + len(row.note);
      line.push(...used <= room ? [[' '.repeat(room - used), ''] as Segment, note] : [[' · ', S.dim] as Segment, note]);
    }
    return fit(line, room);
  });
  const plain = toLines(width);
  if (plain.length <= viewport) return { lines: plain, bar: false };
  return { lines: toLines(width - 3), bar: true };
}

// header is the top line, the same as on the overview. rows is the height of the journal window
// (journalHeight), offset how far it is scrolled in visual lines, focus whether the cursor stands
// in it. now tells today, for the time of a run.
export interface WorkerRenderOptions { timeZone?: string; width?: number; cursor: number; steps: Step[]; header: Segment[];
  now: () => number; rows: number; offset?: number; focus?: boolean }
export function renderWorker(page: WorkerPage, { timeZone, width = WIDTH, cursor, steps, header, now, rows, offset = 0,
  focus = false }: WorkerRenderOptions): Segment[][] {
  const lines: Segment[][] = [header, []];
  const items = workerItems(page);
  const selected = (item: WorkerItem) => items[cursor] === item;
  // With the cursor in the journal the ▸ stands at the heading of the journal: neither the
  // accounts nor the row of actions point anywhere.
  const chosen = (item: WorkerItem): boolean => !focus && selected(item);
  const pointer = (item: WorkerItem): Segment => [chosen(item) ? '▸ ' : '  ', S.cyan];

  // The section «ВОРКЕР»: the platform and its state in one heading, the link, the accounts and
  // the actions in one row, all without their own headings.
  const state: Segment[] = page.switching ? [] : page.paused
    ? [[`● ${t('paused', 'на паузе')}`, S.yellow]]
    : [[`● ${t('active', 'активен')}`, S.green]];
  const heading: Segment[] = [[`${t('WORKER', 'ВОРКЕР')} · ${platformName(page.platform)}`, S.bold]];
  lines.push(...state.length ? [spread(heading, state, width)] : [heading], [['─'.repeat(width), S.dim]]);
  if (page.switching) lines.push([['● ' + t('no active worker: the switch is not finished',
    'активного воркера нет: переключение не завершено'), S.red]]);
  lines.push([[`  ${page.link}`, S.dim]], []);

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
    lines.push(spread([pointer(item), [itemLabel(item, page.platform, page.paused).padEnd(labelWidth), chosen(item) ? S.cyan : ''], ...value],
      [[t('sign in again', 'войти заново'), chosen(item) ? S.cyan : S.dim]], width));
  }

  lines.push([]);
  // The actions in one row: three spaces between the labels — one of the separator and the two
  // of the pointer prefix — the chosen one pointed at and in cyan.
  const actions: Segment[] = [];
  for (const [i, item] of items.slice(FIRST_ACTION).entries()) {
    if (i) actions.push([' ', '']);
    actions.push(pointer(item), [itemLabel(item, page.platform, page.paused), chosen(item) ? S.cyan : '']);
  }
  lines.push(actions, []);

  // The caption of «Починить» / «Переключиться» stands where the journal is, as tall as the
  // journal it replaces, and taller when its text needs more.
  const item = items[cursor];
  const caption = !focus && (item === 'repair' || item === 'switch') ?
    item === 'repair' ? repairCaption() : switchCaption(page.platform) : null;
  if (caption !== null) {
    const wrapped = wrap(caption, width - 4);
    lines.push(...wrapped.map((line): Segment[] => [[`    ${line}`, S.dim]]));
    for (let i = wrapped.length; i < 2 + rows; i++) lines.push([]);
    return lines;
  }

  // The section «ЖУРНАЛ»: the poll on the right of its heading, the window under its line. A
  // poll that got no answer pins its reason over the first row of the window.
  const polled = clock(page.polledAt, timeZone);
  const poll: Segment[] = page.failed ? [[t(`polled ${polled} · no answer`, `опрошен ${polled} · не ответил`), S.yellow]]
    : page.journal ? [[t(`polled ${polled} · answered in ${seconds(page.journal.responseMs)}`,
      `опрошен ${polled} · ответил ${seconds(page.journal.responseMs)}`), S.dim]] : [];
  const viewport = rows - (page.failed ? 1 : 0);
  const { lines: visual, bar } = journalWindow(page, steps, { timeZone, width, now, viewport });
  const total = visual.length;
  const shown = Math.min(offset, Math.max(0, total - viewport));
  const range = (focus || shown > 0) && total ?
    ` · ${shown + 1}–${Math.min(shown + viewport, total)} ${t('of', 'из')} ${total}` : '';
  const mark: Segment[] = focus ? [['▸ ', S.cyan]] : [];
  lines.push(spread([...mark, [`${t('JOURNAL', 'ЖУРНАЛ')}${range}`, S.bold]], poll, width), [['─'.repeat(width), S.dim]]);

  // The pinned reason keeps to its one row: what does not fit ends in «…».
  const room = bar ? width - 3 : width, reason = `  ${page.failed ?? ''}`;
  const window: Segment[][] = [];
  if (page.failed) window.push([[len(reason) <= room ? reason : `${[...reason].slice(0, room - 1).join('')}…`, S.yellow]]);
  if (!total && page.journal) window.push([[t('  no runs yet', '  запусков ещё нет'), S.dim]]);
  window.push(...visual.slice(shown, shown + viewport));
  while (window.length < rows) window.push([]);
  if (bar) {
    // The bar beside the window: what is in view of all there is, at least one row of it.
    const thumb = Math.max(1, Math.round(rows * viewport / total));
    const top = Math.min(rows - thumb, Math.round(shown / Math.max(1, total - viewport) * (rows - thumb)));
    // Each row is padded to the bar, the short ones and the blank ones too.
    window.forEach((line, i) => line.push([' '.repeat(Math.max(0, room - line.reduce((n, [text]) => n + len(text), 0))), ''],
      [`  ${i >= top && i < top + thumb ? '┃' : '│'}`, S.dim]));
  }
  lines.push(...window);
  return lines;
}
