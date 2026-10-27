import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorker, journalHeight, journalWindow, FIRST_ACTION } from '../src/cli/worker-screen.ts';
import type { WorkerPage, WorkerRenderOptions, Step } from '../src/cli/worker-screen.ts';
import type { JournalEntry } from '../src/cli/journal.ts';
import { S } from '../src/cli/overview.ts';
import type { Segment } from '../src/cli/overview.ts';
import { setLanguage } from '../src/cli/language.ts';

// The screen «Воркер» as it is drawn, without the terminal: the two brackets, the journal in its
// window on the rail, the columns of a run and the captions of the actions.
setLanguage('ru');

const NOW = Date.parse('2026-10-26T12:42:00Z');
const at = (time: string): string => new Date(`2026-10-26T${time}:00.000Z`).toISOString();
const run = (time: string, kind: JournalEntry['kind'], outcome: JournalEntry['outcome'], durationMs = 800,
  over: Partial<JournalEntry> = {}): JournalEntry => ({ at: at(time), kind, outcome, durationMs, ...over });

const page = (over: Partial<WorkerPage> = {}): WorkerPage => ({
  link: 'https://script.google.com/home/projects/your-script-id', paused: false,
  account: 'you@gmail.com', accounts: { chatgpt: 'you@gmail.com' }, googleSignIn: true,
  journal: { entries: [], readAt: NOW, responseMs: 400 }, polledAt: Date.parse('2026-10-26T12:42:30Z'), failed: null, ...over });
const render = (p: WorkerPage, over: Partial<WorkerRenderOptions> = {}): Segment[][] =>
  renderWorker(p, { header: [['aures', S.bold]], cursor: FIRST_ACTION, steps: [], rows: 4, now: () => NOW, timeZone: 'UTC', ...over });
const plain = (lines: Segment[][]): string[] => lines.map(line => line.map(([text]) => text).join(''));
// One row of the journal window: the time and the who in their columns, the outcome after them.
const row = (time: string, who: string, text: string, timeWidth: number, whoWidth: number): string =>
  `${time.padEnd(timeWidth + 2)}${who.padEnd(whoWidth + 2)}${text}`;
// The window of the frame starts right under the heading of the journal.
const WINDOW = 13;

test('the frame of the screen «Воркер»: one bracket for the worker, one for the journal', () => {
  const lines = plain(render(page()));
  assert.equal(lines.length, 18, 'the fixed part and a window of 4 rows');
  assert.deepEqual(lines.slice(0, 10), [
    'aures',
    '─'.repeat(72),
    '',
    `╭─ ВОРКЕР · Google Apps Script${' '.repeat(33)}● активен`,
    '│ https://script.google.com/home/projects/your-script-id',
    '│',
    `│ Google    you@gmail.com · вход работает${' '.repeat(19)}войти заново`,
    `│ ChatGPT   you@gmail.com · вход работает${' '.repeat(19)}войти заново`,
    '│',
    '┃ Проверить сейчас   Починить   Пауза',
  ]);
  assert.equal(lines[10], '╰─');
  assert.equal(lines[11], '');
  assert.match(lines[12] ?? '', /^╭─ ЖУРНАЛ {3,}обновлено 12:42:30 · ответ 0,4 с$/);
  assert.equal(lines[13], '│ запусков ещё нет');
  assert.deepEqual(lines.slice(14, 17), ['│', '│', '│'], 'the window keeps its height');
  assert.equal(lines[17], '╰─');
  assert.equal(lines.filter(line => line === '─'.repeat(72)).length, 1, 'one rule, under the header');
  assert.doesNotMatch(lines.join('\n'), /АККАУНТЫ|ДЕЙСТВИЯ|▸/);
});

test('on pause: the label and the actions that apply', () => {
  const paused = render(page({ paused: true }));
  assert.match(plain(paused)[3] ?? '', /● на паузе$/);
  assert.deepEqual(paused[3]?.at(-1), ['на паузе', S.yellow], 'the pause is yellow, dot and label');
  assert.equal(plain(paused)[9], '┃ Проверить сейчас   Починить   Снять с паузы');
  assert.doesNotMatch(plain(render(page())).join('\n'), /Переключ/, 'there is no platform to switch to');
});

test('in English the same frame', () => {
  setLanguage('en');
  try {
    const lines = plain(render(page()));
    assert.match(lines[3] ?? '', /^╭─ WORKER · Google Apps Script {3,}● active$/);
    assert.match(lines[6] ?? '', /^│ Google {4}you@gmail\.com · signed in {3,}sign in again$/);
    assert.match(lines[7] ?? '', /^│ ChatGPT {3}you@gmail\.com · signed in {3,}sign in again$/);
    assert.equal(lines[9], '┃ Check now   Repair   Pause');
    assert.match(lines[12] ?? '', /^╭─ JOURNAL {3,}updated 12:42:30 · answer 0\.4 s$/);
    assert.equal(lines[13], '│ no runs yet');
  } finally { setLanguage('ru'); }
});

test('the journal columns: when, who started it and what came of it', () => {
  const entries = [
    run('12:00', 'login', 'idle', 200), run('12:00', 'trial', 'idle', 300),
    ...['12:10', '12:15', '12:20', '12:25', '12:30', '12:35', '12:40'].map(time => run(time, 'scheduled', 'idle')),
  ];
  const p = page({ journal: { entries, readAt: NOW, responseMs: 400 } });
  const lines = render(p, { steps: [{ at: NOW + 60_000, text: 'воркер залит заново', tone: 'ok' }] });
  assert.deepEqual(plain(lines).slice(WINDOW, WINDOW + 4), [
    `│ ${row('12:43', 'вы', 'воркер залит заново', 11, 10)}`,
    `│ ${row('12:10–12:40', 'расписание', '7 проверок — всё в порядке, применять нечего', 11, 10)}`,
    `│ ${row('12:00', 'вы', 'пробная проверка — применять нечего', 11, 10)}`,
    `│ ${row('12:00', 'вы', 'вход в ChatGPT — сессия воркера обновлена', 11, 10)}`,
  ]);
  // The who of a run of this Mac is the user's, in cyan; the schedule is dim.
  assert.deepEqual(lines[WINDOW + 1]?.[2], ['расписание'.padEnd(12), S.dim]);
  assert.deepEqual(lines[WINDOW + 2]?.[2], ['вы'.padEnd(12), S.cyan]);
  // A step of the CLI says what it did, in dim, with no «aures · » before it.
  assert.deepEqual(lines[WINDOW]?.[3], ['воркер залит заново', S.dim]);
});

test('what a run came to, by its outcome, in the tone it deserves', () => {
  const entries = [
    run('12:20', 'scheduled', 'transient_error'), run('12:15', 'scheduled', 'reauth_required'),
    run('12:10', 'scheduled', 'broken_state', 800, { reason: 'chatgpt' }),
    run('12:05', 'mac', 'idle'), run('12:00', 'trial', 'would_apply', 800),
  ];
  const p = page({ journal: { entries, readAt: NOW, responseMs: 400 } });
  const lines = render(p, { rows: 5 });
  assert.deepEqual(lines.slice(WINDOW, WINDOW + 5).map(line => line.slice(2)), [
    [['расписание'.padEnd(12), S.dim], ['ChatGPT не ответил — повтор при следующем запуске', S.yellow]],
    [['расписание'.padEnd(12), S.dim], ['потерян вход в ChatGPT — нужен новый вход', S.red]],
    [['расписание'.padEnd(12), S.dim], ['данные не читаются (chatgpt)', S.red]],
    [['Mac'.padEnd(12), S.dim], ['кончился недельный лимит — применять нечего', '']],
    [['вы'.padEnd(12), S.cyan], ['пробная проверка — применили бы сброс', '']],
  ], 'no duration on the right, and the start says what kind of run it was');
});

test('an applied run names its reset when the summary says it is the one of that moment', () => {
  const lastApplied = { creditId: 'RateLimitResetCredit_0eb466b3212c819193799a1741f067f8', reason: 'before_expiry' as const,
    at: at('12:05') };
  const entries = [run('12:20', 'apply_now', 'applied', 800), run('12:05', 'apply_now', 'applied', 400)];
  const p = page({ journal: { entries, readAt: NOW, responseMs: 400 } });
  const lines = render(p, { rows: 2, lastApplied });
  assert.deepEqual(lines[WINDOW]?.slice(2), [['вы'.padEnd(4), S.cyan], ['«Применить сейчас» — сброс применён', S.green]],
    'a run the application does not name stays unnamed');
  assert.deepEqual(lines[WINDOW + 1]?.slice(2), [['вы'.padEnd(4), S.cyan],
    ['«Применить сейчас»: применён RES67F8 — перед истечением', S.green]],
    'a colon separates the start when the outcome has a dash of its own');
});

test('the quiet runs of one kind collapse into one line, and only they do', () => {
  const entries = [
    run('12:00', 'trial', 'would_apply', 800), run('12:00', 'trial', 'would_apply', 800),
    run('12:05', 'scheduled', 'applied', 800), run('12:10', 'scheduled', 'applied', 800),
    ...['12:15', '12:20', '12:25'].map(time => run(time, 'trial', 'idle', 300)),
  ];
  const p = page({ journal: { entries, readAt: NOW, responseMs: 400 } });
  assert.equal(journalWindow(p, [], { timeZone: 'UTC', now: () => NOW }).length, 5,
    'what is not quiet does not collapse');
  const rows = plain(render(p, { rows: 4 })).slice(WINDOW, WINDOW + 4);
  assert.deepEqual(rows, [
    `┃ ${row('12:15–12:25', 'вы', 'пробная проверка — применять нечего ×3', 11, 10)}`,
    `┃ ${row('12:10', 'расписание', 'сброс применён', 11, 10)}`,
    `┃ ${row('12:05', 'расписание', 'сброс применён', 11, 10)}`,
    `│ ${row('12:00', 'вы', 'пробная проверка — применили бы сброс', 11, 10)}`,
  ], 'no duration on the right, no ×N on the single runs');
});

test('the Russian count of collapsed checks: 3 проверки, 5 проверок, 11 проверок, 21 проверка', () => {
  for (const [n, word] of [[3, 'проверки'], [5, 'проверок'], [11, 'проверок'], [21, 'проверка']] as const) {
    const entries = Array.from({ length: n }, (_, i) => run(`09:${String(i).padStart(2, '0')}`, 'scheduled', 'idle'));
    const lines = plain(render(page({ journal: { entries, readAt: NOW, responseMs: 400 } }), { rows: 4 }));
    assert.match(lines[WINDOW] ?? '', new RegExp(`^│ [\\d:–]+ +расписание +${n} ${word} — всё в порядке, применять нечего$`),
      `${n} collapses with its count`);
  }
});

test('the time is the clock for a run of today and a day and time for an older one', () => {
  const entries = [run('12:00', 'scheduled', 'idle'),
    { ...run('12:05', 'trial', 'idle'), at: '2026-10-25T12:05:00.000Z' }];
  const lines = plain(render(page({ journal: { entries, readAt: NOW, responseMs: 400 } })));
  assert.match(lines[WINDOW] ?? '', /^│ 12:00 {2}/);
  assert.match(lines[WINDOW + 1] ?? '', /^│ 25 окт 12:05 {2}/);
});

test('the window scrolls in visual lines over the rail of its bracket', () => {
  const entries = ['12:00', '12:05', '12:10', '12:15', '12:20', '12:25']
    .map((time, i) => run(time, i % 2 ? 'mac' : 'scheduled', 'idle'));
  const p = page({ journal: { entries, readAt: NOW, responseMs: 400 } });
  assert.equal(journalWindow(p, [], { timeZone: 'UTC', now: () => NOW }).length, 6);

  const lines = render(p, { rows: 3 });
  assert.deepEqual(lines[12]?.[0], ['╭─ ', S.dim], 'out of the journal the corner is dim');
  assert.match(plain(lines)[WINDOW] ?? '', /^[┃│] 12:25 {2}/, 'the newest first, in view');
  assert.deepEqual(lines[WINDOW]?.[0], ['┃ ', ''], 'the thumb is of the plain colour out of the focus');
  assert.deepEqual(lines[WINDOW + 1]?.[0], ['┃ ', '']);
  assert.deepEqual(lines[WINDOW + 2]?.[0], ['│ ', S.dim]);

  const scrolled = render(p, { rows: 3, offset: 2, focus: true });
  assert.match(plain(scrolled)[12] ?? '', /^╭─ ЖУРНАЛ · 3–5 из 6 {3,}обновлено/);
  assert.deepEqual(scrolled[12]?.[0], ['╭─ ', S.cyan], 'in the journal the corner is cyan');
  assert.deepEqual(scrolled[WINDOW]?.[0], ['│ ', S.dim]);
  assert.deepEqual(scrolled[WINDOW + 1]?.[0], ['┃ ', S.cyan], 'the thumb is cyan in the focus');
  assert.deepEqual(scrolled[WINDOW + 2]?.[0], ['┃ ', S.cyan]);
  assert.deepEqual(scrolled[WINDOW + 3]?.[0], ['╰─', S.cyan]);
});

test('without overflow the window has no heavy rail, and its lines are not three columns narrow', () => {
  const p = page({ journal: { entries: [run('12:00', 'mac', 'idle', 300)], readAt: NOW, responseMs: 400 } });
  const lines = render(p, { rows: 4 });
  const text = 'кончился недельный лимит — применять нечего';
  assert.match(plain(lines)[WINDOW] ?? '', new RegExp(`^│ 12:00 {2}Mac {2}${text}$`));
  assert.deepEqual(lines[WINDOW]?.[0], ['│ ', S.dim], 'no thumb without overflow');
  for (const line of lines.slice(WINDOW + 1, WINDOW + 4)) assert.deepEqual(line[0], ['│', S.dim]);
});

test('a poll that got no answer: the heading says so and the reason stands pinned over the window', () => {
  const p = page({ failed: 'Google недоступен. Повторите: сделанное сохранится.',
    journal: { entries: [run('12:00', 'trial', 'idle', 300)], readAt: NOW, responseMs: 400 } });
  const lines = render(p);
  assert.deepEqual(lines[12]?.at(-1), ['воркер не ответил · 12:42:30', S.yellow]);
  assert.deepEqual(lines[WINDOW], [['│ ', S.dim], ['Google недоступен. Повторите: сделанное сохранится.', S.yellow]],
    'the pinned reason takes the first row of the window');
  assert.equal(plain(lines)[WINDOW + 1], `│ ${row('12:00', 'вы', 'пробная проверка — применять нечего', 5, 2)}`);
});

test('a long line of the journal folds under the column of what came of it', () => {
  const text = 'Переключение: ' + 'шаг переключения, который длился долго и не влез в одну строку. '.repeat(2);
  const steps: Step[] = [{ at: NOW - 60_000, text, tone: 'ok' }, { at: NOW - 120_000, text: 'Проверить сейчас: работает', tone: 'ok' }];
  const all = journalWindow(page(), steps, { timeZone: 'UTC', now: () => NOW });
  assert.ok(all.length >= 4, `the long step folds (${all.length} visual lines)`);
  assert.ok(all[1]?.[0]?.[0].startsWith(' '.repeat(11)), 'the rest folds under the outcome column');
  const drawn = plain(render(page(), { steps, rows: 3 }));
  assert.equal(drawn.length, 17, 'the window is exactly as tall as its rows');
  assert.match(drawn[WINDOW + 1] ?? '', /^[┃│] {12}\S/, 'the folded rest shows as its own line, after the rail');
});

test('the caption of an action: closed, the journal stands right after the corner of the worker', () => {
  const closed = render(page(), { cursor: FIRST_ACTION + 1 });
  assert.equal(plain(closed)[10], '╰─');
  assert.match(plain(closed)[12] ?? '', /^╭─ ЖУРНАЛ/, 'the caption holds no place of its own');
});

test('the caption of an action opens with a rule under its label, what it does up front', () => {
  const p = page({ journal: { entries: [run('12:00', 'trial', 'idle')], readAt: NOW, responseMs: 400 } });
  const open = render(p, { cursor: FIRST_ACTION + 1, caption: true });
  const lines = plain(open);
  assert.equal(lines[10], `│ ${' '.repeat(19)}━━━━━━━━`, 'a rule under «Починить»');
  assert.match(lines[11] ?? '', /^│ {3}Заново залить текущую версию воркера/);
  assert.ok(lines.slice(11).some(line => line.includes('правила, вход в ChatGPT и журнал не трогаются')),
    'the caption wraps to the width');
  assert.ok(lines.some(line => line.startsWith('╭─ ЖУРНАЛ')), 'the journal moves under the caption, and stays');
  assert.ok((open[11] ?? []).some(([text, style]) => text.includes('Заново залить') && style === ''),
    'what the action does is of the plain colour');
  assert.ok(open.slice(12).flat().some(([text, style]) => text.includes('Поможет') && style === S.dim),
    'the details after it are dim');
});

test('every action has its own caption', () => {
  const starts = ['Пробный запуск:', 'Заново залить', 'Снять расписание:'];
  for (const [i, start] of starts.entries()) {
    const lines = plain(render(page(), { cursor: FIRST_ACTION + i, caption: true }));
    assert.match(lines[11] ?? '', new RegExp(`^│ {3}${start}`), `the caption of action ${i}`);
  }
  const paused = plain(render(page({ paused: true }), { cursor: FIRST_ACTION + 2, caption: true }));
  assert.match(paused[11] ?? '', /^╎ {3}Вернуть расписание/);
});

test('the height of the window: the body of the screen matches the overview, the window 3–10 rows', () => {
  assert.equal(journalHeight(null), 6, 'no overview yet');
  assert.equal(journalHeight(12), 3, 'at the floor');
  assert.equal(journalHeight(17), 3);
  assert.equal(journalHeight(20), 6);
  assert.equal(journalHeight(24), 10);
  assert.equal(journalHeight(40), 10, 'at the ceiling');
});
