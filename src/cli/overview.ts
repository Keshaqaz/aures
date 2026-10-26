import type { Repository, WorkflowRun } from '../github/api.ts';
import { FILES, BEFORE_EXPIRY_MS } from '../worker/layout.ts';
import { BEFORE_EXPIRY_MS as GOOGLE_BEFORE_EXPIRY_MS, TICK_MINUTES } from '../apps-script/layout.ts';
import type { JournalEntry } from '../apps-script/worker.ts';
import { readRules, BrokenState, RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import type { Rules } from '../worker/state-file.ts';
import type { Summary } from '../worker/summary.ts';
import { WORKFLOW_FILE, resetName, unfinished, switchUnfinished, ruleLabel, reasonText, attemptResult, enableUrl, byDeadline, readSummary, loggedOutcome,
  failedRunAdvice } from './common.ts';
import type { Logged, Rule } from './common.ts';
import { projectUrl, rulesOf } from './active-worker.ts';
import { platformName } from './switch.ts';
import type { Segment } from './fit.ts';
import { brokenOnGoogle } from './google.ts';
import type { Worker, GoogleWorker } from './active-worker.ts';
import type { Platform } from './watch-files.ts';
import { macCheckStatus, checkAdvice } from './mac-check.ts';
import type { Mac, MacCheck } from './mac-check.ts';
import { t, language, LANGUAGES } from './language.ts';
import pkg from '../../package.json' with { type: 'json' };

// What `status` prints and the screen shows: the resets on top, the general rules under them,
// one line about the worker and the warnings that need the user. The overview keeps what it
// read and is worded when drawn, so the screen can change the language on the spot.

// The cron asks for every hour, but GitHub runs it every 6–8 hours; the before-expiry rule
// leaves no more than its window, so a longer silence is worth the user's attention. The same
// holds on Google, with its window.
const WINDOW_MS: Record<Platform, number> = { github: BEFORE_EXPIRY_MS, google: GOOGLE_BEFORE_EXPIRY_MS };
// Runs of the worker on Google that only the user can mend.
const USER_MENDS: JournalEntry['outcome'][] = ['reauth_required', 'broken_state'];
export const WIDTH = 72;
export const RULES: Rule[] = ['beforeExpiry', 'weeklyAutoApply'];

// SGR codes of the segments.
export const S = { bold: '1', dim: '2', green: '32', yellow: '33', red: '31', cyan: '1;36' };
export type Tone = 'ok' | 'warn' | 'bad';
const TONES: Record<Tone, string> = { ok: S.green, warn: S.yellow, bad: S.red };
const MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
};

// «22 Oct 15:00» in the user's time zone.
export function shortTime(ms: number, timeZone?: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(ms).map(part => [part.type, part.value]));
  return `${parts.day} ${MONTHS[language()][Number(parts.month) - 1]} ${parts.hour}:${parts.minute}`;
}

// «in 2d 3h» until a moment.
function timeLeft(ms: number): string {
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (minutes < 60) return t(`in ${Math.max(1, minutes)}m`, `через ${Math.max(1, minutes)} мин`);
  if (hours < 24) return t(`in ${hours}h`, `через ${hours} ч`);
  const rest = hours % 24;
  return t(`in ${days}d${rest ? ` ${rest}h` : ''}`, `через ${days} д${rest ? ` ${rest} ч` : ''}`);
}

const runAt = (run: WorkflowRun): number => Date.parse(run.run_started_at ?? run.created_at);

// When the cron should run next: the last scheduled run plus the median gap between the recent
// ones, newest first. Dispatched runs do not move the schedule. null until two scheduled runs.
function nextScheduledRun(runs: WorkflowRun[]): number | null {
  const times = runs.map(runAt);
  const gaps = times.slice(1).map((at, i) => (times[i] ?? at) - at).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return times[0] === undefined || median === undefined ? null : times[0] + median;
}

// What the overview knows of the worker on its platform. On GitHub: the workflow and its runs;
// the logged outcome is the one of a failed last run. On Google: the schedule and the journal.
export type WorkerView =
  | { platform: 'github'; repo: Repository; workflowState: string | null; lastRun: WorkflowRun | null;
    // When the cron last started the worker; null before its first run.
    lastScheduledAt: number | null;
    // null until the cron has run twice.
    nextRunAt: number | null;
    logged: Logged | null }
  | { platform: 'google'; scriptId: string; schedule: boolean; journal: JournalEntry[] };

// Everything the overview shows, read from the worker (what it publishes openly: on GitHub it
// cannot read the sealed state) and from this Mac.
export interface Overview {
  worker: WorkerView;
  readAt: number;
  // null before the worker's first read.
  resets: Summary['resets'] | null;
  // null when there is no rules file or it does not read.
  rules: Rules | null;
  rulesBroken: boolean;
  // The install record says the worker is on pause (ADR-0007): its schedule is off.
  paused: boolean;
  // A switch of platform is not finished: no worker is active.
  switching: boolean;
  check: MacCheck;
  lastApplied: Summary['lastApplied'];
  lastAttempt: Summary['lastAttempt'];
}
// What the install record of this Mac says about a pause and an unfinished switch of platform.
const readRecord = async (mac: Mac): Promise<{ paused: boolean; switching: boolean }> => {
  const install = await mac.files.readInstall();
  return { paused: install?.paused === true, switching: Boolean(install?.switching) };
};
export async function readOverview({ worker, mac, now }: { worker: Worker; mac: Mac; now: () => number }): Promise<Overview> {
  if (worker.platform === 'google') return readGoogle({ worker, mac, now });
  const { api, repo } = worker, name = repo.full_name;
  const [summary, rulesFile, workflowState, lastRun, scheduled, record] = await Promise.all([readSummary(api, repo), api.file(name, FILES.rules),
    api.workflowState(name, WORKFLOW_FILE), api.latestRun(name, WORKFLOW_FILE), api.scheduledRuns(name, WORKFLOW_FILE), readRecord(mac)]);
  let rules: Rules | null = null;
  try { rules = rulesFile && readRules(rulesFile.text); } catch (error) { if (!(error instanceof BrokenState)) throw error; }
  const check = await macCheckStatus({ weekly: rules?.weeklyAutoApply ?? null, mac });
  const failed = lastRun?.status === 'completed' && lastRun.conclusion !== 'success';
  const logged = failed ? loggedOutcome(await api.runLog(name, lastRun.id).catch(() => null)) : null;
  return { worker: { platform: 'github', repo, workflowState, lastRun, lastScheduledAt: scheduled[0] ? runAt(scheduled[0]) : null,
    nextRunAt: nextScheduledRun(scheduled), logged }, readAt: now(), resets: summary ? byDeadline(summary.resets) : null, rules,
  rulesBroken: Boolean(rulesFile && !rules), ...record, check, lastApplied: summary?.lastApplied ?? null, lastAttempt: summary?.lastAttempt ?? null };
}

// On Google everything comes in one doPost status. The worker there keeps no rules it cannot read.
async function readGoogle({ worker, mac, now }: { worker: GoogleWorker; mac: Mac; now: () => number }):
  Promise<Overview> {
  const [status, record] = await Promise.all([worker.status(), readRecord(mac)]);
  const summary = status.summary as Summary | null, rules = rulesOf(status.rules);
  // The check from this Mac does not wake the worker on Google yet: it is shown as off.
  const check = await macCheckStatus({ weekly: null, mac });
  return { worker: { platform: 'google', scriptId: worker.scriptId, schedule: status.schedule === true,
    journal: Array.isArray(status.journal) ? status.journal as JournalEntry[] : [] }, readAt: now(),
  resets: summary ? byDeadline(summary.resets) : null, rules, rulesBroken: false, ...record, check, lastApplied: summary?.lastApplied ?? null,
  lastAttempt: summary?.lastAttempt ?? null };
}

type WorkerState = { tone: Tone; label: string; detail?: string | null; warning?: string };
// A worker on pause (CONTEXT.md): the schedule is off by the user's choice, the session and the
// state stay. With no pause timer every reset left to itself burns at its deadline, so the
// warning stands and «Применить сейчас» is the only thing that still applies (ADR-0007).
const pausedWorker = (): WorkerState => ({
  tone: 'warn',
  label: t('paused', 'на паузе'),
  warning: t('The worker is paused: resets are not applied and each burns at its activation deadline. «Apply now» still works.',
    'Воркер на паузе: сбросы не применяются и каждый сгорит в свой срок активации. «Применить сейчас» продолжает работать.'),
});
const nextRun = (nextRunAt: number | null, readAt: number): WorkerState => {
  const label = t('active', 'активен');
  if (nextRunAt === null) return { tone: 'ok', label, detail: t('waiting for a scheduled run', 'ждёт запуска по расписанию') };
  if (nextRunAt <= readAt) return { tone: 'ok', label, detail: t('next run due any moment', 'следующий запуск ожидается в любой момент') };
  return { tone: 'ok', label, detail: t(`next run expected ${timeLeft(nextRunAt - readAt)}`,
    `следующий запуск ожидается ${timeLeft(nextRunAt - readAt)}`) };
};
const executions = (scriptId: string): string => `${projectUrl(scriptId)}/executions`;

// The worker in its label beside the section heading, the detail under it and what the user
// should do about it (issue 03). The next run counts down to now, as the rule under the header
// does (issue 04).
function workerState({ worker, readAt, paused, switching }: Overview, timeZone?: string, now = readAt): WorkerState {
  if (switching) return { tone: 'bad', label: t('no active worker', 'нет активного воркера'),
    detail: t('the switch is not finished', 'переключение не завершено'), warning: switchUnfinished() };
  if (paused) return pausedWorker();
  if (worker.platform === 'google') return googleState(worker, readAt, timeZone, now);
  const { repo, workflowState, lastRun, lastScheduledAt, nextRunAt } = worker;
  if (!workflowState) return { tone: 'warn', label: t('setup unfinished', 'установка не завершена'), warning: unfinished() };
  if (workflowState !== 'active') {
    return { tone: 'bad', label: t('disabled in GitHub', 'выключен в GitHub'),
      warning: t(`Resets are not applied. Turn the worker on with the Enable workflow button: ${enableUrl(repo)}`,
        `Сбросы не применяются. Включите воркер кнопкой Enable workflow: ${enableUrl(repo)}`) };
  }
  if (!lastRun) return { tone: 'warn', label: t('not run yet', 'ещё не запускался') };
  if (lastRun.status !== 'completed') return { tone: 'ok', label: t('active', 'активен'), detail: t('running now', 'запуск идёт сейчас') };
  const at = shortTime(runAt(lastRun), timeZone);
  if (lastRun.conclusion !== 'success') return { tone: 'bad', label: t('last run failed', 'ошибка запуска'),
    detail: t(`last run failed · ${at}`, `последний запуск с ошибкой · ${at}`) };
  const hours = Math.floor((readAt - runAt(lastRun)) / 3600_000);
  if (readAt - runAt(lastRun) > WINDOW_MS.github) {
    return { tone: 'warn', label: t(`silent ${hours}h`, `молчит ${hours} ч`),
      warning: t(`The worker has not run for ${hours}h. Check: ${repo.html_url}/actions`,
        `Воркер не запускался уже ${hours} ч. Проверьте: ${repo.html_url}/actions`) };
  }
  // Runs from this Mac or apply-now do not stand in for the cron: the before-expiry rule rests on it.
  if (lastScheduledAt !== null && readAt - lastScheduledAt > WINDOW_MS.github) {
    const silent = Math.floor((readAt - lastScheduledAt) / 3600_000);
    return { tone: 'warn', label: t('no scheduled run', 'нет запусков по расписанию'), detail: t(`none for ${silent}h`, `уже ${silent} ч`),
      warning: t(`GitHub has not run the worker on schedule for ${silent}h, and the before-expiry rule depends on it. Check: ${repo.html_url}/actions`,
        `GitHub не запускал воркер по расписанию уже ${silent} ч, а правило перед истечением зависит от этих запусков. Проверьте: ${repo.html_url}/actions`) };
  }
  return nextRun(nextRunAt, now);
}

// The tone of the worker as the section «ВОРКЕР» tells it, and whether its last run failed: the
// screen colours its runners by them (issue 04).
export const workerTone = (model: Overview): Tone => workerState(model).tone;
export const lastRunFailed = (model: Overview): boolean => !model.switching && !model.paused && failedRun(model) !== null;

// The latest scheduled run in a journal of the worker on Google.
export const lastScheduled = (journal: { kind: string; at: string }[]): number | null => {
  const found = journal.findLast(entry => entry.kind === 'scheduled');
  return found ? Date.parse(found.at) : null;
};

// From the last scheduled run to the next one expected, the same data as the detail of the
// section «ВОРКЕР» says (issue 04); approx on GitHub, whose cron keeps no time. scheduledAt is a
// later scheduled run the screen «Воркер» read in its own journal. null when nothing tells it.
export interface Countdown { from: number; to: number; approx: boolean }
export function countdown({ worker }: Overview, scheduledAt: number | null = null): Countdown | null {
  if (worker.platform === 'google') {
    const last = Math.max(lastScheduled(worker.journal) ?? -Infinity, scheduledAt ?? -Infinity);
    return last === -Infinity ? null : { from: last, to: last + TICK_MINUTES * 60_000, approx: false };
  }
  const { lastScheduledAt, nextRunAt } = worker;
  if (lastScheduledAt === null || nextRunAt === null) return null;
  const from = Math.max(lastScheduledAt, scheduledAt ?? -Infinity);
  return { from, to: from + nextRunAt - lastScheduledAt, approx: true };
}

// The rule under the header (issue 04): the part of the wait for the next scheduled run that has
// passed, heavy (━) up to its end (╸), the rest light — dashed in its last third where the time is
// only expected. Past the end and no new run seen, all heavy. On pause the whole rule is dashed,
// with no worker active it is torn, after a failed last run the passed part is yellow.
export function ruleLine(model: Overview | null, { now, width = WIDTH, scheduledAt = null }:
  { now: () => number; width?: number; scheduledAt?: number | null }): Segment[] {
  if (!model) return [['─'.repeat(width), S.dim]];
  if (model.switching) return [[[...'─'.repeat(width)].map((c, i) => i % 6 === 5 ? ' ' : c).join(''), S.dim]];
  if (model.paused) return [['╌'.repeat(width), S.dim]];
  const span = countdown(model, scheduledAt);
  if (!span || span.to <= span.from) return [['─'.repeat(width), S.dim]];
  const passed = lastRunFailed(model) ? S.yellow : S.dim;
  if (now() >= span.to) return [['━'.repeat(width), passed]];
  const done = Math.floor(width * Math.max(0, now() - span.from) / (span.to - span.from));
  const rest = width - done - 1, dashed = span.approx ? Math.ceil(rest / 3) : 0;
  return [['━'.repeat(done), passed], ['╸', passed === S.yellow ? S.yellow : ''], ['─'.repeat(rest - dashed), S.dim],
    ['╌'.repeat(dashed), S.dim]].filter(([text]) => text) as Segment[];
}

// The character of a bracket (issue 04): solid while the worker is active, dashed on pause, torn
// — every third line of the section without its rail — while no worker is active. from is the
// heading of the section; its lines down to the corner change in place.
export type Rail = 'solid' | 'dashed' | 'broken';
export function railed(lines: Segment[][], from: number, rail: Rail): void {
  if (rail === 'solid') return;
  for (let i = from; i < lines.length; i++) {
    const first = lines[i]?.[0];
    if (!first) continue;
    const [text, style] = first, line = lines[i] as Segment[];
    if (i === from) { if (rail === 'dashed') line[0] = [text.replace('─', '╌'), style]; continue; }
    if (text.startsWith('╰')) { if (rail === 'dashed') line[0] = [text.replace('─', '╌'), style]; return; }
    if (!text.startsWith('│')) continue;
    if (rail === 'dashed') line[0] = [text.replace('│', '╎'), style];
    else if ((i - from) % 3 === 0) line[0] = [text.replace('│', ' '), style];
  }
}

// On Google by the schedule and the journal: the latest run of any kind, and the latest scheduled one.
function googleState({ scriptId, schedule, journal }: Extract<WorkerView, { platform: 'google' }>, readAt: number, timeZone?: string,
  now = readAt): WorkerState {
  if (!schedule) {
    return { tone: 'bad', label: t('no schedule', 'нет расписания'),
      warning: t('Resets are not applied. Repair the worker: «Repair» on the screen «Worker» (Tab in `aures`) puts the schedule back.',
        'Сбросы не применяются. Почините воркер: «Починить» на экране «Воркер» (Tab в `aures`) вернёт расписание.') };
  }
  const last = journal.at(-1);
  if (!last) return { tone: 'warn', label: t('not run yet', 'ещё не запускался') };
  if (USER_MENDS.includes(last.outcome)) {
    const at = shortTime(Date.parse(last.at), timeZone);
    return { tone: 'bad', label: t('last run failed', 'ошибка запуска'),
      detail: t(`last run failed · ${at}`, `последний запуск с ошибкой · ${at}`) };
  }
  const scheduled = journal.findLast(entry => entry.kind === 'scheduled');
  const scheduledAt = scheduled ? Date.parse(scheduled.at) : null;
  if (scheduledAt !== null && readAt - scheduledAt > WINDOW_MS.google) {
    const silent = Math.floor((readAt - scheduledAt) / 3600_000);
    return { tone: 'warn', label: t('no scheduled run', 'нет запусков по расписанию'), detail: t(`none for ${silent}h`, `уже ${silent} ч`),
      warning: t(`Google has not run the worker on schedule for ${silent}h, and the before-expiry rule depends on it. Check: ${executions(scriptId)}`,
        `Google не запускал воркер по расписанию уже ${silent} ч, а правило перед истечением зависит от этих запусков. Проверьте: ${executions(scriptId)}`) };
  }
  return nextRun(scheduledAt === null ? null : scheduledAt + TICK_MINUTES * 60_000, now);
}

// What the user does about a failed last run, with where to see it.
function failedRun({ worker }: Overview): string | null {
  const details = t('Details', 'Подробности');
  if (worker.platform === 'github') {
    const { lastRun, logged } = worker;
    return lastRun?.status === 'completed' && lastRun.conclusion !== 'success' ? `${failedRunAdvice(logged ?? {})} ${details}: ${lastRun.html_url}` : null;
  }
  const last = worker.journal.at(-1);
  if (!last || !USER_MENDS.includes(last.outcome)) return null;
  const advice = last.outcome === 'broken_state' ? brokenOnGoogle(last.reason) : failedRunAdvice({ outcome: last.outcome });
  return `${advice} ${details}: ${executions(worker.scriptId)}`;
}

// The latest application, or a later attempt that did not apply.
function lastEvent({ lastApplied: applied, lastAttempt: attempt }: Overview, timeZone?: string): string | null {
  if (attempt && attempt.result !== 'reset' && (!applied || attempt.at > applied.at)) {
    const at = shortTime(Date.parse(attempt.at), timeZone);
    return t(`attempt ${resetName(attempt.creditId)} ${at} — ${attemptResult(attempt.result)}`, `попытка ${resetName(attempt.creditId)} ${at} — ${attemptResult(attempt.result)}`);
  }
  if (!applied) return null;
  const at = shortTime(Date.parse(applied.at), timeZone);
  return t(`applied ${resetName(applied.creditId)} ${at} — ${reasonText(applied.reason)}`, `применён ${resetName(applied.creditId)} ${at} — ${reasonText(applied.reason)}`);
}

// What the cursor can stand on: the resets, then the rules.
export type Item = { kind: 'reset'; creditId: string } | { kind: 'rule'; rule: Rule };
export const overviewItems = (model: Overview): Item[] => [
  ...(model.resets ?? []).map(reset => ({ kind: 'reset', creditId: reset.creditId }) as const),
  ...(model.rules ? RULES.map(rule => ({ kind: 'rule', rule }) as const) : [])];
export const sameItem = (a: Item, b: Item | undefined): boolean =>
  a.kind === 'reset' ? b?.kind === 'reset' && b.creditId === a.creditId : b?.kind === 'rule' && b.rule === a.rule;

// Lines are made of segments, [text, style] (fit.ts).
export type { Segment } from './fit.ts';
const len = (text: string): number => [...text].length;
// A line with segments on the left and on the right edge.
const spread = (left: Segment[], right: Segment[], width: number): Segment[] => {
  const used = [...left, ...right].reduce((n, [text]) => n + len(text), 0);
  return [...left, [' '.repeat(Math.max(2, width - used)), ''], ...right];
};

// The top line: the program, its version, the time and, on the screen, the languages.
export function headerLine({ now, timeZone, width = WIDTH, toggle = false }: Omit<RenderOptions, 'cursor'>): Segment[] {
  const languages = toggle ? LANGUAGES.flatMap((code, i): Segment[] => [[i ? ' · ' : '   ', S.dim],
    [code.toUpperCase(), code === language() ? S.cyan : S.dim]]) : [];
  return spread([['aures', S.bold], [` ${pkg.version}`, S.dim]], [[shortTime(now(), timeZone), S.dim], ...languages], width);
}

// Lines of [text, style] segments. cursor is the index in overviewItems, or null without one;
// toggle shows the languages in the header, for the screen — and takes the link of the worker
// off it, for the screen «Воркер» has it.
export interface RenderOptions { now: () => number; timeZone?: string; width?: number; cursor?: number | null; toggle?: boolean }
export function renderOverview(model: Overview, { now, timeZone, width = WIDTH, cursor = null, toggle = false }: RenderOptions): Segment[][] {
  const lines: Segment[][] = [], items = overviewItems(model);
  const at = (item: Item) => cursor !== null && sameItem(item, items[cursor]);
  // The section language (issue 03): an open bracket around a section, its lines on a rail the
  // cursor makes heavy, one blank line between the sections.
  const rail = (selected = false): Segment => [selected ? '┃ ' : '│ ', selected ? S.cyan : S.dim];
  const open = (name: Segment[], right: Segment[] = []): void => {
    lines.push(right.length ? spread([['╭─ ', S.dim], ...name], right, width) : [['╭─ ', S.dim], ...name]);
  };

  lines.push(headerLine({ now, timeZone, width, toggle }), ruleLine(model, { now, width }), []);
  const resetsTitle = t('RESETS', 'СБРОСЫ'), resets = model.resets ?? [];
  open([[resetsTitle, S.bold], ...(resets.length ? [[` · ${resets.length}`, S.dim]] as Segment[] : [])]);
  if (!model.resets) lines.push([rail(), [t('not read yet — the worker reads them on its next run', 'ещё не прочитаны — воркер прочитает их при следующем запуске'), S.dim]]);
  else if (!resets.length) lines.push([rail(), [t('no resets', 'сбросов нет'), S.dim]]);
  const idWidth = Math.max(0, ...resets.map(reset => len(resetName(reset.creditId))));
  for (const reset of resets) {
    const selected = at({ kind: 'reset', creditId: reset.creditId });
    const expiresAt = reset.expiresAt ? Date.parse(reset.expiresAt) : null;
    // On pause no rule applies anything, so every reset with a deadline waits only to burn; one
    // without a deadline cannot burn and keeps its «no expiry».
    const status: Segment = expiresAt === null ? ['', ''] : expiresAt <= now() ? [t('expired', 'срок вышел'), S.dim] :
      model.paused || model.switching ? [t('burns', 'сгорит'), S.yellow] :
      model.rules?.beforeExpiry && expiresAt - now() <= WINDOW_MS[model.worker.platform] ? [t('applies soon', 'скоро применится'), S.yellow] :
        [timeLeft(expiresAt - now()), S.dim];
    lines.push(spread([rail(selected), [resetName(reset.creditId).padEnd(idWidth + 3), selected ? S.cyan : ''], status],
      [[expiresAt === null ? t('no expiry', 'без срока') : shortTime(expiresAt, timeZone), selected ? S.cyan : S.dim]], width));
  }
  lines.push([['╰─', S.dim]]);

  lines.push([]);
  open([[t('RULES', 'ПРАВИЛА'), S.bold]]);
  if (model.rulesBroken) lines.push([rail(), [t('do not read', 'не читаются'), S.yellow]]);
  else if (!model.rules) lines.push([rail(), [t('not set', 'не заданы'), S.dim]]);
  for (const rule of model.rules ? RULES : []) {
    const on = model.rules?.[rule], selected = at({ kind: 'rule', rule });
    const check: Segment = rule !== 'weeklyAutoApply' || !on || model.check.state === 'off' ? ['', ''] : model.check.state === 'working' ?
      [t(' · Mac check works', ' · проверка с Mac работает'), S.dim] : [t(' · Mac check is not working', ' · проверка с Mac не работает'), S.yellow];
    lines.push([rail(selected), [on ? '☑ ' : '☐ ', on ? S.green : S.dim],
      [ruleLabel(rule, model.worker.platform), selected ? S.cyan : on ? '' : S.dim], check]);
  }
  lines.push([['╰─', S.dim]]);

  const worker = workerState(model, timeZone, now()), last = lastEvent(model, timeZone);
  lines.push([]);
  const heading = lines.length;
  open([[t('WORKER', 'ВОРКЕР'), S.bold], [` · ${platformName(model.worker.platform)}`, S.dim]],
    [['● ', TONES[worker.tone]], [worker.label, TONES[worker.tone]]]);
  if (worker.detail) lines.push([rail(), [worker.detail, worker.tone === 'ok' ? '' : TONES[worker.tone]]]);
  if (last) lines.push([rail(), [last, S.dim]]);
  if (!toggle) lines.push([rail(), [model.worker.platform === 'github' ? model.worker.repo.html_url : projectUrl(model.worker.scriptId), S.dim]]);
  lines.push([['╰─', S.dim]]);
  railed(lines, heading, model.switching ? 'broken' : model.paused ? 'dashed' : 'solid');
  const warnings: (string | null | undefined)[] = [worker.warning];
  if (model.rulesBroken) warnings.push(t('The rules do not read. Choose them again: `aures rules`.',
    'Правила не читаются. Выберите их заново: `aures rules`.'));
  warnings.push(failedRun(model));
  if (model.check.problem) warnings.push(checkAdvice(model.check.problem));
  for (const warning of warnings.filter((w): w is string => Boolean(w))) lines.push([['! ', S.yellow], [warning, S.yellow]]);
  return lines;
}

export const paint = (segments: Segment[], color: boolean | undefined): string => segments.map(([text = '', style = '']) =>
  color && style && text ? `\x1b[${style}m${text}\x1b[0m` : text).join('');
