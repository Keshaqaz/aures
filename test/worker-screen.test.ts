import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorker, journalHeight, journalWindow, FIRST_ACTION } from '../src/cli/worker-screen.ts';
import type { WorkerPage, WorkerRenderOptions, Step } from '../src/cli/worker-screen.ts';
import type { JournalEntry } from '../src/cli/journal.ts';
import { S } from '../src/cli/overview.ts';
import type { Segment } from '../src/cli/overview.ts';
import { setLanguage } from '../src/cli/language.ts';

// The screen «Воркер» as it is drawn, without the terminal: the compact frame, the journal in
// its scrolling window, the collapsing of runs and the captions of «Починить» and «Переключиться».
setLanguage('ru');

const NOW = Date.parse('2026-10-26T12:42:00Z');
const at = (time: string): string => new Date(`2026-10-26T${time}:00.000Z`).toISOString();
const run = (time: string, kind: JournalEntry['kind'], outcome: JournalEntry['outcome'], durationMs = 800,
  over: Partial<JournalEntry> = {}): JournalEntry => ({ at: at(time), kind, outcome, durationMs, ...over });
// One row of the window as it stands in the frame: the time in its column, the text, and the
// duration or the count on the right edge.
const row = (time: string, text: string, note: string | null = null, timeWidth = 5, width = 72): string => {
  const head = `  ${time.padEnd(timeWidth)}  ${text}`;
  return note === null ? head : head + ' '.repeat(width - [...head].length - [...note].length) + note;
};

const page = (over: Partial<WorkerPage> = {}): WorkerPage => ({
  platform: 'google', link: 'https://script.google.com/home/projects/your-script-id', paused: false, switching: null,
  account: 'you@gmail.com', accounts: { chatgpt: 'you@gmail.com' }, googleSignIn: true,
  journal: { entries: [], readAt: NOW, responseMs: 400 }, polledAt: Date.parse('2026-10-26T12:42:30Z'), failed: null, ...over });
const render = (p: WorkerPage, over: Partial<WorkerRenderOptions> = {}): Segment[][] =>
  renderWorker(p, { header: [['aures', S.bold]], cursor: FIRST_ACTION, steps: [], rows: 4, now: () => NOW, timeZone: 'UTC', ...over });
const plain = (lines: Segment[][]): string[] => lines.map(line => line.map(([text]) => text).join(''));
const win = (p: WorkerPage, steps: Step[] = [], viewport: number) =>
  journalWindow(p, steps, { timeZone: 'UTC', now: () => NOW, viewport });

test('the frame of the screen «Воркер»: two sections and the actions in one row', () => {
  const lines = plain(render(page()));
  assert.equal(lines.length, 17, 'the fixed part and a window of 4 rows');
  assert.deepEqual(lines.slice(0, 5), [
    'aures',
    '',
    `ВОРКЕР · Google Apps Script${' '.repeat(36)}● активен`,
    '─'.repeat(72),
    '  https://script.google.com/home/projects/your-script-id',
  ]);
  assert.equal(lines[5], '');
  assert.match(lines[6] ?? '', /^ {2}Google {4}you@gmail\.com · вход работает {3,}войти заново$/);
  assert.match(lines[7] ?? '', /^ {2}ChatGPT {3}you@gmail\.com · вход работает {3,}войти заново$/);
  assert.equal(lines[8], '');
  assert.equal(lines[9], '▸ Проверить сейчас   Починить   Пауза   Переключиться на GitHub Actions');
  assert.equal(lines[10], '');
  assert.match(lines[11] ?? '', /^ЖУРНАЛ {3,}опрошен 12:42:30 · ответил 0,4 с$/);
  assert.equal(lines[12], '─'.repeat(72));
  assert.equal(lines[13], '  запусков ещё нет');
  assert.deepEqual(lines.slice(14), ['', '', ''], 'the window keeps its height');
  assert.doesNotMatch(lines.join('\n'), /АККАУНТЫ|ДЕЙСТВИЯ|~1 мин Actions/);
});

test('on GitHub, on pause and in an unfinished switch: the state and the actions that apply', () => {
  const github = plain(render(page({ platform: 'github', account: 'octo-fake', googleSignIn: null,
    link: 'https://github.com/octo-fake/codex-auto-resets-worker' })));
  assert.match(github[2] ?? '', /^ВОРКЕР · GitHub Actions {3,}● активен$/);
  assert.equal(github[9], '▸ Проверить сейчас   Починить   Пауза   Переключиться на Google Apps Script');

  const paused = render(page({ paused: true }));
  assert.match(plain(paused)[2] ?? '', /● на паузе$/);
  assert.deepEqual(paused[2]?.at(-1), ['● на паузе', S.yellow], 'the pause is yellow, dot and word');
  assert.equal(plain(paused)[9], '▸ Проверить сейчас   Починить   Снять с паузы');
  assert.doesNotMatch(plain(paused).join('\n'), /Переключиться/);

  const switching = render(page({ switching: { from: 'github' } }));
  assert.equal(plain(switching)[2], 'ВОРКЕР · Google Apps Script', 'no state beside an unfinished switch');
  assert.deepEqual(switching[4], [['● активного воркера нет: переключение не завершено', S.red]]);
  assert.equal(plain(switching)[5], '  https://script.google.com/home/projects/your-script-id');
  assert.equal(plain(switching)[10], '▸ Повторить переключение');
});

test('in English the same frame', () => {
  setLanguage('en');
  try {
    const lines = plain(render(page({ platform: 'github', account: 'octo-fake', googleSignIn: null,
      link: 'https://github.com/octo-fake/codex-auto-resets-worker' })));
    assert.match(lines[2] ?? '', /^WORKER · GitHub Actions {3,}● active$/);
    assert.match(lines[6] ?? '', /^ {2}GitHub {4}octo-fake {3,}sign in again$/);
    assert.match(lines[7] ?? '', /^ {2}ChatGPT {3}you@gmail\.com · signed in {3,}sign in again$/);
    assert.equal(lines[9], '▸ Check now   Repair   Pause   Switch to Google Apps Script');
    assert.match(lines[11] ?? '', /^JOURNAL {3,}polled 12:42:30 · answered in 0\.4 s$/);
    assert.equal(lines[13], '  no runs yet');
  } finally { setLanguage('ru'); }
});

test('runs of the same kind and outcome in a row collapse into one line with a time range and their count', () => {
  const entries = [
    run('12:00', 'login', 'idle', 200), run('12:00', 'trial', 'idle', 300), run('12:05', 'scheduled', 'applied', 800),
    ...['12:10', '12:15', '12:20', '12:25', '12:30', '12:35', '12:40'].map(time => run(time, 'scheduled', 'idle')),
  ];
  const lines = plain(render(page({ journal: { entries, readAt: NOW, responseMs: 400 } })));
  assert.deepEqual(lines.slice(13), [
    row('12:10–12:40', 'по расписанию · применять нечего', '×7', 11),
    row('12:05', 'по расписанию · сброс применён', '0,8 с', 11),
    row('12:00', 'пробный · применять нечего', '0,3 с', 11),
    row('12:00', 'вход · применять нечего', '0,2 с', 11),
  ]);
});

test('a step of the CLI breaks the run, and a bad outcome never collapses', () => {
  const entries = [
    run('12:10', 'scheduled', 'idle'), run('12:20', 'scheduled', 'idle'),
    run('12:30', 'scheduled', 'reauth_required'), run('12:35', 'scheduled', 'reauth_required'),
  ];
  const steps: Step[] = [{ at: Date.parse('2026-10-26T12:15:00.000Z'), text: 'что-то сделал', tone: 'ok' }];
  const p = page({ journal: { entries, readAt: NOW, responseMs: 400 } });
  const lines = plain(render(p, { steps, rows: 5 }));
  assert.deepEqual(lines.slice(13), [
    row('12:35', 'по расписанию · потерян вход в ChatGPT', '0,8 с'),
    row('12:30', 'по расписанию · потерян вход в ChatGPT', '0,8 с'),
    row('12:20', 'по расписанию · применять нечего', '0,8 с'),
    row('12:15', 'aures · что-то сделал'),
    row('12:10', 'по расписанию · применять нечего', '0,8 с'),
  ]);
});

test('the time is the clock for a run of today and a day and time for an older one', () => {
  const entries = [run('12:00', 'scheduled', 'idle'),
    { ...run('12:05', 'trial', 'idle'), at: '2026-10-25T12:05:00.000Z' }];
  const lines = plain(render(page({ journal: { entries, readAt: NOW, responseMs: 400 } })));
  assert.match(lines[13] ?? '', /^ {2}12:00 {9}по расписанию · применять нечего/);
  assert.match(lines[14] ?? '', /^ {2}25 окт 12:05 {2}пробный · применять нечего/);
});

test('the window scrolls in visual lines, with a bar beside what is in view', () => {
  const entries = ['12:00', '12:05', '12:10', '12:15', '12:20', '12:25']
    .map((time, i) => run(time, i % 2 ? 'mac' : 'scheduled', 'idle'));
  const p = page({ journal: { entries, readAt: NOW, responseMs: 400 } });
  const { lines: all, bar } = win(p, [], 3);
  assert.equal(all.length, 6);
  assert.ok(bar, 'more visual lines than the window has rows');

  const lines = plain(render(p, { rows: 3 }));
  assert.match(lines[11] ?? '', /^ЖУРНАЛ {3,}опрошен/);
  assert.match(lines[13] ?? '', /^ {2}12:25 {2}/, 'the newest first');
  assert.equal(lines[13]?.slice(-3), '  ┃');
  assert.equal(lines[14]?.slice(-3), '  ┃');
  assert.equal(lines[15]?.slice(-3), '  │');

  const scrolled = plain(render(p, { rows: 3, offset: 2, focus: true }));
  assert.match(scrolled[11] ?? '', /^▸ ЖУРНАЛ · 3–5 из 6 {3,}опрошен/);
  assert.match(scrolled[13] ?? '', /^ {2}12:15 {2}/);
  assert.equal(scrolled[13]?.slice(-3), '  │');
  assert.equal(scrolled[14]?.slice(-3), '  ┃');
  assert.equal(scrolled[15]?.slice(-3), '  ┃');
});

test('a long line of the journal folds under itself and the window counts the visual lines', () => {
  const text = 'Переключение: ' + 'шаг переключения, который длился долго и не влез в одну строку. '.repeat(2);
  const steps: Step[] = [{ at: NOW - 60_000, text, tone: 'ok' }, { at: NOW - 120_000, text: 'Проверить сейчас: работает', tone: 'ok' }];
  const { lines, bar } = win(page(), steps, 3);
  assert.ok(lines.length >= 4, `the long step folds (${lines.length} visual lines)`);
  assert.ok(bar);
  assert.ok(lines[1]?.[0]?.[0].startsWith(' '.repeat(9)), 'the rest folds under the column of the time');
  const drawn = plain(render(page(), { steps, rows: 3 }));
  assert.equal(drawn.length, 13 + 3, 'the window is exactly as tall as its rows');
  assert.match(drawn[14] ?? '', /^ {9}\S/, 'the folded rest shows as its own line');
});

test('the bar stands on the right edge of every row of the window, whatever the length of the row', () => {
  const steps: Step[] = [{ at: NOW - 60_000, text: 'Пауза: на паузе', tone: 'ok' }];
  const entries = ['12:00', '12:05', '12:10', '12:15'].map((time, i) => run(time, i % 2 ? 'mac' : 'scheduled', 'idle'));
  const failed = 'Google недоступен: ' + 'сервер ответил ошибкой и не вернул журнал воркера. '.repeat(2);
  const p = page({ failed, journal: { entries, readAt: NOW, responseMs: 400 } });
  const lines = plain(render(p, { steps, rows: 4 })).slice(13);
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.equal([...line].length, 72, line);
    assert.match(line.slice(-3), /^ {2}[┃│]$/, line);
  }
  assert.match(lines[0] ?? '', /^ {2}Google недоступен: .*…/, 'the pinned reason keeps to its row');
});

test('a poll that got no answer: the heading says so and the reason stands pinned over the window', () => {
  const p = page({ failed: 'Google недоступен. Повторите: сделанное сохранится.',
    journal: { entries: [run('12:00', 'trial', 'idle', 300)], readAt: NOW, responseMs: 400 } });
  const lines = render(p);
  assert.deepEqual(lines[11]?.at(-1), ['опрошен 12:42:30 · не ответил', S.yellow]);
  assert.deepEqual(lines[13], [['  Google недоступен. Повторите: сделанное сохранится.', S.yellow]]);
  assert.equal(plain(lines)[14], row('12:00', 'пробный · применять нечего', '0,3 с'));
});

test('the caption of «Починить» or «Переключиться» stands where the journal is, not less tall', () => {
  const withJournal = render(page());
  const repair = render(page({ journal: { entries: [run('12:00', 'trial', 'idle')], readAt: NOW, responseMs: 400 } }), { cursor: 3 });
  assert.doesNotMatch(plain(repair).join('\n'), /ЖУРНАЛ/);
  assert.ok(plain(repair).slice(11).every(line => line === '' || line.startsWith('    ')));
  assert.ok(repair.length >= withJournal.length, 'the area is as tall as the journal it replaces');

  const switching = plain(render(page(), { cursor: 5 }));
  assert.match(switching[11] ?? '', /^ {4}Воркер на GitHub Actions готовится/);
  assert.doesNotMatch(switching.join('\n'), /ЖУРНАЛ/);
});

test('with the cursor in the journal the ▸ stands at its heading, and no action is pointed at', () => {
  const entries = ['12:00', '12:05', '12:10', '12:15', '12:20', '12:25']
    .map((time, i) => run(time, i % 2 ? 'mac' : 'scheduled', 'idle'));
  const p = page({ journal: { entries, readAt: NOW, responseMs: 400 } });
  const row = '  Проверить сейчас   Починить   Пауза   Переключиться на GitHub Actions';
  const lines = render(p, { rows: 3, offset: 2, focus: true });
  assert.deepEqual(lines[11]?.[0], ['▸ ', S.cyan]);
  assert.equal(plain(lines)[9], row, 'the row points nowhere');
  assert.match(plain(lines)[6] ?? '', /^ {2}Google /, 'nor do the accounts');

  // Off the journal the ▸ returns to the chosen action and the heading has none.
  const back = render(p, { rows: 3, offset: 2 });
  assert.equal(plain(back)[9], '▸ ' + row.slice(2));
  assert.match(plain(back)[11] ?? '', /^ЖУРНАЛ · 3–5 из 6 {3,}опрошен/);
  assert.deepEqual(back[9]?.[0], ['▸ ', S.cyan]);
});

test('the height of the window: the body of the screen matches the overview, the window 3–10 rows', () => {
  assert.equal(journalHeight(null), 6, 'no overview yet');
  assert.equal(journalHeight(12), 3, 'at the floor');
  assert.equal(journalHeight(14), 3);
  assert.equal(journalHeight(20), 7);
  assert.equal(journalHeight(23), 10);
  assert.equal(journalHeight(40), 10, 'at the ceiling');
});
