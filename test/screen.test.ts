import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setup } from '../src/cli/setup.ts';
import { openScreen, runScreen, viewport } from '../src/cli/screen.ts';
import type { Screen } from '../src/cli/screen.ts';
import { cliWorld } from './support/cli-world.ts';
import pkg from '../package.json' with { type: 'json' };
import { credit } from './support/fake-world.ts';
import { status } from '../src/cli/status.ts';
import { language } from '../src/cli/language.ts';
import { pauseWorker } from '../src/cli/pause.ts';
import { login } from '../src/cli/login.ts';
import type { Language } from '../src/cli/language.ts';
import { setLanguage } from '../src/cli/language.ts';
import { renderOverview } from '../src/cli/overview.ts';
import type { Overview } from '../src/cli/overview.ts';

const HINT = '↑↓ выбор · Enter применить · Tab воркер · l язык · r обновить · q выход';

// The screen of a worker installed by setup with the default rules: resets reset-b (in 2 days
// 3 hours) and reset-a (in 5 days). Device codes the screen shows are approved at once.
async function opened({ language = 'ru' }: { language?: Language } = {}) {
  const env = await cliWorld({ language });
  const { code, io } = await env.run(setup);
  assert.equal(code, 0, io.output());
  let screen: Screen | undefined;
  const sleep = async (ms: number) => {
    for (const note of screen?.notes ?? []) {
      for (const [found] of note.text.matchAll(/FAKE-\d+/g)) env.world.approve(found);
    }
    env.world.advance(ms);
  };
  await env.run(async options => { screen = await openScreen({ ...options, sleep }); screen.motion = false; return 0; });
  assert.ok(screen);
  const shown = screen;
  const press = (...names: string[]) => names.reduce<Promise<unknown>>((done, name) => done.then(() => shown.press({ name, sequence: name })),
    Promise.resolve());
  const text = () => shown.frame().join('\n');
  const project = env.world.google.project();
  assert.ok(project?.gas);
  return { ...env, project, gas: project.gas, screen: shown, press, text };
}

test('the screen shows the resets on top, the rules under them and moves the cursor over both', async () => {
  const { screen, press, text } = await opened();
  assert.equal(screen.frame()[4], `┃ reset-b   через 2 д 2 ч${' '.repeat(35)}22 окт 15:00`);
  assert.match(text(), /ПРАВИЛА\n│ ☑ Перед истечением \(в последний час\)\n│ ☑ Когда кончится недельный лимит/);
  assert.equal(screen.frame().at(-1), HINT);

  await press('down', 'down', 'down');
  assert.match(text(), /┃ ☑ Когда кончится недельный лимит/);
  await press('down');
  assert.match(text(), /┃ reset-b/, 'the cursor goes round');
  await press('up');
  assert.match(text(), /┃ ☑ Когда кончится недельный лимит/);
});

test('both screens in brackets: sections open and close, one rule under the header, no ▸ anywhere', async () => {
  const { screen, press, text } = await opened();
  assert.match(text(), /\n─+\n\n╭─ СБРОСЫ · 2\n[┃│] reset-b {3}[^\n]*\n[┃│] reset-a {3}[^\n]*\n╰─\n\n╭─ ПРАВИЛА\n/);
  assert.match(text(), /\n╰─\n\n╭─ ВОРКЕР · Google Apps Script {3,}● активен\n│ ждёт запуска по расписанию\n╰─\n/);
  assert.equal(screen.frame().filter(line => line === '─'.repeat(72)).length, 1, 'the one rule is under the header');
  assert.doesNotMatch(text(), /▸/);

  await press('tab');
  assert.match(text(), /\n╭─ ВОРКЕР · Google Apps Script {3,}● активен\n│ https:\/\/script\.google\.com\/home\/projects\/[^\n]+\n│\n/);
  assert.match(text(), /\n┃ Проверить сейчас[^\n]*\n╰─\n\n╭─ ЖУРНАЛ {3,}обновлено [^\n]*\n(?:[┃│] [^\n]*\n)+(?:│\n)*╰─\n/);
  assert.equal(screen.frame().filter(line => line === '─'.repeat(72)).length, 1, 'the one rule is under the header here too');
  assert.doesNotMatch(text(), /▸/);
});

test('in a narrow terminal every line of both screens folds under its text, none wider than the frame (issue 32)', async () => {
  const { screen, press } = await opened();
  const width = 40;
  const narrow = () => screen.frame(width, false, true);
  for (const line of narrow()) assert.ok([...line].length <= width, line);
  await press('tab');
  for (const line of narrow()) assert.ok([...line].length <= width, line);
  assert.ok(narrow().some(line => line.startsWith('│ https://script.google.com/')), narrow().join('\n'));
  assert.deepEqual(screen.frame().filter(line => [...line].length > width).length > 0, true, 'the lines themselves stay whole');
  screen.close();
});

test('Enter on a reset applies it now after a «y», any other key cancels', async () => {
  const { world, press, text, screen } = await opened();
  await press('down', 'return');
  assert.equal(screen.frame().at(-1), 'Применить reset-a сейчас? Сброс одноразовый. y — да, другая клавиша — отмена');
  await press('n');
  assert.equal(screen.frame().at(-1), HINT);
  assert.deepEqual(world.spent(), [], 'nothing is applied without the «y»');

  await press('return');
  await screen.press({ sequence: 'н' }); // «y» on the Russian layout
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.match(text(), /\nСброс reset-a применён\.\n/);
  assert.match(text(), /СБРОСЫ · 1\n┃ reset-b/, 'the applied reset is gone and the cursor stays in the list');
  assert.match(text(), /применён reset-a 20 окт 12:00 — вручную/);

  await press('down');
  assert.doesNotMatch(text(), /применён\./, 'the next key clears the result');
});

test('Enter on a rule switches it in the worker, and the weekly rule needs nothing from this Mac', async () => {
  const { gas, mac, press, text } = await opened();
  const rules = () => JSON.parse(gas.properties.get('rules') ?? 'null');
  await press('down', 'down', 'down', 'return');
  assert.deepEqual(rules(), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false });
  assert.match(text(), /Правила сохранены и заработают со следующего запуска воркера\./);
  assert.match(text(), /┃ ☐ Когда кончится недельный лимит\n/);
  assert.doesNotMatch(text(), /FAKE-\d+|проверка с Mac/, 'no sign-in and no check from this Mac');

  await press('return');
  assert.equal(rules().weeklyAutoApply, true);
  assert.match(text(), /┃ ☑ Когда кончится недельный лимит\n/);
  assert.deepEqual(mac.launchctl.calls, []);
});

test('a reset with an ID as ChatGPT gives it is shown as RES and the last 4 characters and applied by the whole ID', async () => {
  const { world, gas, press, text, screen } = await opened();
  const id = 'RateLimitResetCredit_0eb466b3212c819193799a1741f067f8';
  world.chatgpt.credits.push(credit(id, world.now + 3 * 86400_000));
  world.advance(5 * 60_000);
  gas.tick();
  await screen.load();
  assert.match(text(), /\n│ RES67F8 {3}через 2 д 23 ч/);
  assert.doesNotMatch(text(), /RateLimitResetCredit/);
  await press('down', 'return');
  assert.match(screen.frame().at(-1) ?? '', /^Применить RES67F8 сейчас\?/);
  await press('y');
  assert.deepEqual(world.spent(), [id]);
  assert.match(text(), /\nСброс RES67F8 применён\.\n/);
  assert.match(text(), /применён RES67F8 /);
});

test('a failed action shows why and leaves the screen open', async () => {
  const { world, project, press, text, screen } = await opened();
  project.deployments.clear();
  await press('return', 'y');
  assert.match(text(), /\nОшибка Google \(web_app_404\)\. Повторите: сделанное сохранится\.\n/);
  assert.equal(screen.busy, null);
  assert.deepEqual(world.spent(), []);
});

// The screen in a fake terminal of the size given: its output and keys.
function terminal(screen: Screen, size: { columns: number; rows: number }) {
  const input = new PassThrough(), output = Object.assign(new PassThrough(), size);
  let written = '';
  output.on('data', (chunk: Buffer) => { written += chunk; });
  const done = runScreen(screen, { input, output }, { AURES_MOTION: 'off' });
  const press = async (key: string) => { const from = written.length; input.write(key); await new Promise(resolve => setImmediate(resolve));
    return written.slice(from); };
  return { input, done, press, written: () => written };
}
const visible = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('the terminal: the screen takes the alternate screen, redraws the lines that changed, q gives the terminal back', async () => {
  const { screen } = await opened();
  const { done, press, written } = terminal(screen, { columns: 100, rows: 40 });
  assert.ok(written().startsWith('\x1b[?1049h\x1b[?25l'), 'the alternate screen, without the cursor');
  assert.match(written(), /\x1b\[2;1H {2}\x1b\[1maures/, 'a margin around the screen');
  const moved = await press('\x1b[B');
  assert.match(moved, /\x1b\[6;1H\x1b\[2K\x1b\[6;1H {2}\x1b\[2m│ \x1b\[0mreset-b/);
  assert.match(moved, /\x1b\[7;1H\x1b\[2K\x1b\[7;1H {2}\x1b\[1;36m┃ \x1b\[0m\x1b\[1;36mreset-a/);
  assert.equal([...moved.matchAll(/\x1b\[2K/g)].length, 2, 'only the two lines of the cursor');
  await press('q');
  assert.equal(await done, 0);
  assert.ok(written().endsWith('\x1b[?25h\x1b[?1049l'), 'the cursor and the terminal as it was are back');
});

test('the terminal: a frame taller than the terminal keeps its header and keys and never scrolls it', async () => {
  const { screen } = await opened();
  const { input, done, written } = terminal(screen, { columns: 100, rows: 8 });
  try {
    const rows = [...written().matchAll(/\x1b\[(\d+);1H/g)].map(([, row]) => Number(row));
    assert.equal(Math.max(...rows), 8);
    assert.doesNotMatch(written(), /\n/, 'no line feed that could scroll the terminal');
    assert.match(visible(written()), /aures/, 'the header stays');
    assert.match(visible(written()), /↑↓ выбор/, 'the keys stay');
    assert.match(visible(written()), /┃ reset-b/, 'the cursor is in view');
    assert.match(visible(written()), /↓ ещё \d+/, 'a mark tells what is hidden below');
  } finally {
    input.write('q');
    assert.equal(await done, 0);
  }
});

// A frame taller than the terminal moves with the cursor (issue 33): the selected line by its
// index, the place the Screen found as it drew.
test('viewport: the middle follows the cursor, the first item shows the top and the last the bottom', () => {
  const frame = ['header', 'a', '┃ b', 'c', 'd', 'e', 'f', '', 'keys'];
  const plain = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
  const first = viewport(frame, { rows: 7, foot: 2, offset: 0, edge: 'first', selected: 2 });
  assert.deepEqual(plain(first.lines), ['header', 'a', '┃ b', 'c', '↓ ещё 3', '', 'keys'], 'nothing hidden above takes no row');
  const down = ['header', 'a', 'b', 'c', '┃ d', 'e', 'f', '', 'keys'];
  const middle = viewport(down, { rows: 7, foot: 2, offset: first.offset, edge: null, selected: 4 });
  assert.deepEqual(plain(middle.lines), ['header', '↑ ещё 2', 'c', '┃ d', '↓ ещё 2', '', 'keys']);
  const last = viewport(['header', 'a', 'b', '┃ c', 'd', 'e', 'f', '', 'keys'],
    { rows: 7, foot: 2, offset: middle.offset, edge: 'last', selected: 3 });
  assert.deepEqual(plain(last.lines), ['header', '↑ ещё 2', '┃ c', 'd', '↓ ещё 2', '', 'keys'], 'the cursor stays in view');
  const none = viewport(['header', 'a', 'b', '┃ c', 'd', 'e', 'f', '', 'keys'],
    { rows: 7, foot: 2, offset: middle.offset, edge: null, selected: -1 });
  assert.equal(none.offset, middle.offset, 'a frame without a selected line keeps its place');
  const caption = viewport(['header', 'rule', '', 'a', '┃ b', 'c', 'd', 'e', '', 'keys'],
    { rows: 8, foot: 2, offset: 0, edge: null, selected: 4, through: 5, head: 2 });
  assert.deepEqual(plain(caption.lines), ['header', 'rule', '↑ ещё 1', '┃ b', 'c', '↓ ещё 2', '', 'keys'],
    'the header and its rule stay, the selected line and the lines that go with it are in view');
  const top = viewport(['header', 'rule', '', 'a', '┃ b', 'c', 'd', 'e', '', 'keys'],
    { rows: 8, foot: 2, offset: 0, edge: null, selected: 4, head: 2 });
  assert.deepEqual(plain(top.lines), ['header', 'rule', '', 'a', '┃ b', '↓ ещё 3', '', 'keys'], 'the top stands as the whole frame has it');
  const low = viewport(['header', 'rule', '', 'a', '┃ b', 'c', 'd', 'e', '', 'keys'],
    { rows: 6, foot: 2, offset: 0, edge: null, selected: 4, head: 2 });
  assert.deepEqual(plain(low.lines), ['header', '↑ ещё 2', '┃ b', '↓ ещё 3', '', 'keys'], 'too low for the rule: only the header stays');
  const fits = viewport(frame, { rows: 20, foot: 2, offset: 3, edge: null, selected: 2 });
  assert.deepEqual(fits, { lines: frame, offset: 0 });
});

test('the terminal: with the cursor in the journal its heading, in cyan, stays in view', async () => {
  const { screen } = await opened();
  const { input, done, press, written } = terminal(screen, { columns: 100, rows: 8 });
  try {
    await press('\t'); // the screen «Воркер»
    while (screen.busy !== null || screen.view !== 'worker') await new Promise(resolve => setImmediate(resolve));
    const inJournal = await press('\x1b[B'); // ↓: into the journal
    assert.match(visible(inJournal), /╭─ ЖУРНАЛ/, 'the heading of the journal carries the focus');
    assert.doesNotMatch(visible(inJournal), /┃ Проверить/, 'the row of actions points nowhere');
    assert.match(visible(written()), /↑↓ листать/, 'the keys of the journal stay in view');
  } finally {
    input.write('q');
    assert.equal(await done, 0);
  }
});

test('the screen in English: l switches to Russian and back, keeping the choice on this Mac', async () => {
  const { mac, press, text, screen, run } = await opened({ language: 'en' });
  assert.equal(screen.frame()[0], `aures ${pkg.version}${' '.repeat(44 - pkg.version.length)}20 Oct 12:00   EN · RU`);
  assert.equal(screen.frame()[4], `┃ reset-b   in 2d 2h${' '.repeat(40)}22 Oct 15:00`);
  assert.match(text(), /RULES\n│ ☑ Before expiry \(in the last hour\)\n│ ☑ When the weekly limit runs out/);
  assert.match(text(), /● active/);
  assert.match(text(), /\n│ waiting for a scheduled run/);
  assert.equal(screen.frame().at(-1), '↑↓ select · Enter apply · Tab worker · l language · r refresh · q quit');

  await press('l');
  assert.equal(language(), 'ru');
  assert.equal(await mac.files.readLanguage(), 'ru');
  assert.match(text(), /СБРОСЫ · 2[\s\S]*ПРАВИЛА/);
  assert.equal(screen.frame().at(-1), HINT);
  await screen.press({ sequence: 'д' }); // «l» on the Russian layout
  assert.equal(language(), 'en');
  assert.equal(await mac.files.readLanguage(), 'en');
  assert.match(text(), /RESETS · 2/);

  const { io } = await run(status);
  assert.match(io.output(), /^aures \S+ +20 Oct 12:00\n/, 'status has no language toggle');
  assert.match(io.output(), /RESETS · 2/);
});

// The screen «Воркер» (issues 11, 15): Tab from the resets and back, the platform and its
// accounts, the actions in one row and the live journal in a window that scrolls.
const WORKER_HINT = '↑↓←→ выбор · Enter действие · Tab сбросы · l язык · r обновить · q выход';
const SCROLL_HINT = '↑↓ листать · PgUp PgDn страница · Home свежие · Esc действия · q выход';
const REPAIR_CAPTION = 'Заново залить текущую версию воркера и вернуть расписание. Сбросы, правила, вход в ChatGPT ' +
  'и журнал не трогаются. Поможет, если воркер перестал запускаться или его файлы меняли вручную';
const HOUR = 3600_000, MINUTE = 60_000, DAY = 24 * HOUR;

// The screen of the worker on Google, as the tests that name the platform call it.
const openedOnGoogle = (): ReturnType<typeof opened> => opened();
// The caption of an action as one line, the way the frame wraps it.
// The text of a caption; a dashed bracket (a pause) has its rail dashed.
const caption = (frame: string[]): string => frame.filter(line => /^[│╎ ] {3}\S/.test(line)).map(line => line.slice(4)).join(' ');

test('a long line of a section folds on the rail of its bracket: the bracket stays whole', async () => {
  const { screen, press, project } = await openedOnGoogle();
  await press('tab');
  const frame = screen.frame(50, false, true);
  const from = frame.findIndex(line => line.startsWith('╭─ ВОРКЕР')), to = frame.findIndex((line, i) => i > from && line.startsWith('╰─'));
  const section = frame.slice(from + 1, to);
  assert.ok(section.some(line => line === `│ ${project.scriptId}`), section.join('\n'));
  assert.ok(section.every(line => /^[│┃]/.test(line)), `every line on the rail:\n${section.join('\n')}`);
});

test('the terminal: an open caption keeps the header and its rule in place and comes into view', async () => {
  const { world, screen } = await openedOnGoogle();
  const { input, done, press, written } = terminal(screen, { columns: 100, rows: 17 });
  try {
    await press('\t');
    while (screen.busy !== null || screen.view !== 'worker') await new Promise(resolve => setImmediate(resolve));
    const rule = (text: string) => [...text.matchAll(/\x1b\[(\d+);1H {2}\x1b\[2m[─━╸]/g)].map(([, row]) => Number(row));
    assert.deepEqual(rule(written()).slice(-1), [3]);
    await press('\x1b[C'); // →: on «Починить»
    world.advance(400);
    const from = written().length;
    (screen.changed as () => void)();
    const after = written().slice(from);
    assert.doesNotMatch(after, /\x1b\[3;1H\x1b\[2K\x1b\[3;1H\x1b\[\?2026l|\x1b\[4;1H {2}\x1b\[2m[─━╸]/, 'the rule stays on its row');
    assert.match(visible(after), /вручную/, 'the last line of the caption is in view');
    assert.match(visible(after), /↑ ещё \d+/, 'what went up is marked');
  } finally {
    input.write('q');
    assert.equal(await done, 0);
  }
});

test('the screen «Воркер» on Google: the platform, its accounts and the caption of «Починить» by dwell', async () => {
  const { world, screen, press, text, project } = await openedOnGoogle();
  await screen.press({ name: 'tab', sequence: '\t' });
  assert.match(text(), new RegExp(`\n╭─ ВОРКЕР · Google Apps Script {3,}● активен\n│ https://script\\.google\\.com/home/projects/${project.scriptId}\n│\n`));
  assert.match(text(), /\n│ Google {4}owner@example\.invalid · вход работает {3,}войти заново\n│ ChatGPT {3}fake@example\.invalid · вход работает {3,}войти заново\n│\n/);
  assert.match(text(), /\n┃ Проверить сейчас {3}Починить {3}Пауза\n╰─\n\n╭─ ЖУРНАЛ/);
  // The journal is newest first in its window: the trial run of setup, then its login.
  assert.match(text(), /\n╭─ ЖУРНАЛ {3,}обновлено 12:00:\d\d · ответ 0,0 с\n│ 12:00 {2}вы {2}пробная проверка — применять нечего\n│ 12:00 {2}вы {2}вход в ChatGPT — сессия воркера обновлена\n/);
  assert.equal(caption(screen.frame()), '', 'the caption shows under the cursor only');
  const withJournal = screen.frame().length;

  await press('right');
  assert.equal(caption(screen.frame()), '', 'the cursor has just come on «Починить»');
  world.advance(399);
  assert.equal(caption(screen.frame()), '', '400 ms has not passed yet');
  world.advance(1);
  assert.match(screen.frame().join('\n'), /\n│ {20}━━━━━━━━/, 'a rule under the chosen label');
  assert.equal(caption(screen.frame()), REPAIR_CAPTION);
  assert.ok(screen.frame().every(line => [...line].length <= 72), 'the caption wraps to the width');
  assert.ok(screen.frame().length > withJournal, 'the caption makes the frame taller, the journal moves under it');
  assert.match(text(), /\n╭─ ЖУРНАЛ/, 'the journal stays in the frame');

  await press('up');
  assert.equal(caption(screen.frame()), '', '↑ from the row closes the caption');
  assert.match(text(), /\n╰─\n\n╭─ ЖУРНАЛ/, 'the journal is back right after the corner');
  await press('down'); // ↓ from ChatGPT lands on the action chosen last
  assert.equal(caption(screen.frame()), '', 'a new dwell starts');
  world.advance(400);
  assert.equal(caption(screen.frame()), REPAIR_CAPTION, 'and after 400 ms it opens again');
  await press('right');
  assert.equal(caption(screen.frame()), 'Снять расписание: правила перестают применять сбросы, каждый сгорит в свой срок. ' +
    '«Применить сейчас» продолжает работать.', 'an open caption moves to the neighbour without a new dwell');

  await press('tab');
  assert.match(text(), /СБРОСЫ · 2/);
  await press('tab');
  assert.match(text(), /ВОРКЕР/);
  assert.match(text(), /\n┃ Проверить сейчас/, 'Tab back opens the first action');
  assert.equal(caption(screen.frame()), '', 'the caption does not open with the screen');
});

test('the screen «Воркер» in English', async () => {
  const { screen, press, text } = await opened({ language: 'en' });
  await press('tab');
  assert.match(text(), /\n╭─ WORKER · Google Apps Script {3,}● active\n/);
  assert.match(text(), /\n│ Google {4}owner@example\.invalid · signed in {3,}sign in again\n│ ChatGPT {3}fake@example\.invalid · signed in {3,}sign in again\n│\n/);
  assert.match(text(), /\n┃ Check now {3}Repair {3}Pause\n/);
  assert.match(text(), /\n╭─ JOURNAL {3,}updated 12:00:\d\d · answer 0\.0 s\n│ 12:00 {2}you {2}trial check — nothing to apply\n/);
  assert.equal(screen.frame().at(-1), '↑↓←→ select · Enter run · Tab resets · l language · r refresh · q quit');
});

test('the hints of the screen «Воркер» fit the width in both languages, in the journal and out', async () => {
  const { screen, press } = await opened();
  await press('tab');
  const hintFits = () => { const hint = screen.frame().at(-1) ?? ''; assert.ok([...hint].length <= 72, hint); };
  hintFits(); // outside the journal
  await press('down');
  hintFits(); // in the journal
  setLanguage('en');
  try {
    await press('escape');
    hintFits();
    await press('down');
    hintFits();
  } finally { setLanguage('ru'); }
});

test('the height of the screen «Воркер» follows the overview: the window 3–10 rows', async () => {
  const { world, screen, press } = await opened();
  const body = () => screen.frame().length - 2; // without the blank and the hint under the body
  const model = screen.model;
  assert.ok(model);
  const withResets = (n: number): Overview => ({ ...model, resets: Array.from({ length: n }, (_, i) =>
    ({ creditId: `reset-${i}`, expiresAt: new Date(world.now + (i + 2) * DAY).toISOString() })) });

  await press('tab');
  assert.equal(body(), 14 + 3, '2 resets: the window at its floor of 3 rows');
  await press('tab');

  screen.model = withResets(4);
  await press('tab');
  assert.equal(body(), renderOverview(screen.model!, { now: screen.now, timeZone: 'UTC', toggle: true }).length, 'as tall as the overview');
  await press('tab');

  screen.model = withResets(8);
  await press('tab');
  assert.equal(body(), 14 + 8);
  await press('tab');

  screen.model = withResets(25);
  await press('tab');
  assert.equal(body(), 14 + 10, 'the window at its ceiling of 10 rows');
  screen.close();
});

// Enough runs of two kinds to fill the window and scroll: the scheduled ones and the failed
// ones, alternating so that no two neighbours collapse into one line.
const manyRuns = async (opened: Awaited<ReturnType<typeof openedOnGoogle>>, n: number): Promise<void> => {
  const { world, gas } = opened;
  for (let i = 0; i < n; i++) {
    world.advance(5 * MINUTE);
    if (i % 2) world.chatgpt.fail = { status: 500, body: { detail: 'no' } };
    gas.tick();
    world.chatgpt.fail = null;
  }
};

test('the journal in its window: the rail, the range in the heading, the keys and the hints', async () => {
  const opened = await openedOnGoogle();
  await manyRuns(opened, 9);
  const { screen, press, text } = opened;
  await press('tab');
  assert.match(text(), /\n╭─ ЖУРНАЛ {3,}обновлено [^\n]*\n[┃│] 12:45 [^\n]*\n[┃│] 12:40 [^\n]*\n[┃│] 12:35 /, 'the rail of the bracket marks what is in view');
  assert.equal(screen.frame().at(-1), WORKER_HINT);

  await press('down'); // into the journal
  assert.equal(screen.frame().at(-1), SCROLL_HINT, 'the hint says what the keys do in the journal');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 1–3 из 11 {3,}обновлено [^\n]*\n[┃│] 12:45 {2}/);
  await press('down');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 2–4 из 11 {3,}обновлено/);
  await press('pageup');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 1–3 из 11 {3,}обновлено/);
  await press('pagedown');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 4–6 из 11 {3,}обновлено/);
  await press('home');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 1–3 из 11 {3,}обновлено/);
  await press('pagedown', 'pagedown', 'pagedown');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 9–11 из 11 {3,}обновлено/, 'no further than the bottom');
  await press('up');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 8–10 из 11 {3,}обновлено/);

  await press('escape'); // back to the actions, the window where it was
  assert.equal(screen.frame().at(-1), WORKER_HINT);
  assert.match(text(), /\n┃ Проверить сейчас/, 'the cursor returns to the chosen action');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 8–10 из 11 {3,}обновлено/, 'the heading keeps its range');
  await press('down', 'home', 'up'); // in, to the top, and ↑ back to the actions
  assert.equal(screen.frame().at(-1), WORKER_HINT);
  assert.doesNotMatch(text(), /ЖУРНАЛ · /, 'the top shows no range');
  assert.equal(await screen.press({ name: 'escape', sequence: '\x1b' }), 'exit', 'Esc outside the journal closes the screen');
});

test('new runs arrive on top without moving the lines the window is scrolled to', async () => {
  const opened = await openedOnGoogle();
  await manyRuns(opened, 9);
  const { world, gas, screen, press, text } = opened;
  await press('tab', 'down', 'pagedown');
  assert.match(text(), /\n╭─ ЖУРНАЛ · 4–6 из 11 {3,}обновлено [^\n]*\n[┃│] 12:30 {2}/);
  const seen = screen.frame().find(line => line.includes('12:30'));

  world.advance(5 * MINUTE);
  world.chatgpt.fail = { status: 500, body: { detail: 'no' } };
  gas.tick();
  world.chatgpt.fail = null;
  await press('r'); // the poll reads the journal again
  assert.match(text(), /\n╭─ ЖУРНАЛ · 5–7 из 12 {3,}обновлено/);
  assert.equal(screen.frame().find(line => line.includes('12:30')), seen, 'the same line stays on top of the window');
});

test('the journal collapses a run of identical ticks into one line with their count', async () => {
  const { world, gas, press, text } = await openedOnGoogle();
  for (let i = 0; i < 7; i++) { world.advance(5 * MINUTE); gas.tick(); }
  await press('tab');
  assert.match(text(), /\n│ 12:05–12:35 {2}расписание {2}7 проверок — всё в порядке, применять нечего\n│ 12:00 {8}вы {10}пробная проверка — применять нечего\n│ 12:00 {8}вы {10}вход в ChatGPT — сессия воркера обновлена\n/);
});

test('«Проверить сейчас» on Google asks the worker for a trial run and the journal tells what the rules would apply', async () => {
  const { world, gas, press, text } = await openedOnGoogle();
  world.chatgpt.credits.push(credit('reset-c', world.now + 30 * MINUTE));
  await press('tab', 'return');
  assert.deepEqual(world.spent(), []);
  const journal = JSON.parse(gas.properties.get('journal') ?? '[]') as { kind: string; outcome: string }[];
  assert.deepEqual(journal.at(-1), { at: new Date(world.now).toISOString(), kind: 'trial', outcome: 'would_apply', durationMs: 0,
    wouldApply: { creditId: 'reset-c', reason: 'before_expiry' } });
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}Проверить сейчас: /);
  await press('down', 'down', 'down'); // into the journal, past the folded step
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}пробная проверка: применили бы reset-c — перед истечением\n/);
});

test('«Починить» on Google deploys this version into the same deployment and brings the schedule back, the data stays', async () => {
  const { world, project, gas, screen, press, text, secretKeychain } = await openedOnGoogle();
  const [deploymentId] = [...project.deployments.keys()];
  const versions = project.versions.length;
  const source = project.files.find(file => file.name === 'worker')?.source;
  const worker = project.files.find(file => file.name === 'worker');
  assert.ok(worker);
  worker.source = '// changed by hand\n';
  gas.triggers.length = 0;
  const properties = new Map(gas.properties);

  await press('tab', 'right', 'return', 'left');
  assert.equal(screen.busy, null);
  assert.equal(project.files.find(file => file.name === 'worker')?.source, source);
  assert.deepEqual([...project.deployments], [[deploymentId, versions + 1]], 'the same deployment, so the same URL');
  assert.equal(await secretKeychain.read(), world.google.deployedSecret());
  const live = world.google.project()?.gas;
  assert.ok(live);
  assert.deepEqual(live.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.deepEqual(new Map(live.properties), properties, 'the state, the rules and the journal are untouched');
  assert.match(text(), /\n[┃│] [\d:–]+ +вы +Починить: Воркер починен: залита версия/);
  assert.match(text(), /расписание\n[┃│] +вернулось\./);

  // The screen goes on with the new secret.
  await press('return');
  assert.match(text(), /\n[┃│] [\d:–]+ +вы +Проверить сейчас: /);
  assert.deepEqual(world.google.violations, []);
});

test('«Починить» on a paused Google worker deploys the code but leaves the schedule off', async () => {
  const { world, run, press, text } = await openedOnGoogle();
  assert.equal((await run(pauseWorker)).code, 0);
  await press('tab');
  assert.match(text(), /\n╭╌ ВОРКЕР · Google Apps Script {3,}● на паузе\n/);
  await press('right', 'return', 'left');
  assert.deepEqual(world.google.project()?.gas?.triggers, []);
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}Починить: Воркер починен: залита версия/);
  assert.match(text(), /осталось снятым\./);
});

test('«Пауза» and «Снять с паузы» on Google: the trigger goes off and comes back, the journal tells both steps', async () => {
  const { gas, mac, screen, press, text } = await openedOnGoogle();
  await press('tab');
  assert.match(text(), /\n┃ Проверить сейчас {3}Починить {3}Пауза\n/);

  await press('right', 'right', 'return');
  assert.equal(screen.busy, null);
  assert.deepEqual(gas.triggers, []);
  assert.equal((await mac.files.readInstall())?.paused, true);
  assert.match(text(), /\n╭╌ ВОРКЕР · Google Apps Script {3,}● на паузе\n/);
  assert.match(text(), /\n┃ Проверить сейчас {3}Починить {3}Снять с паузы\n/);
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}Пауза: Воркер на паузе: расписание снято/);

  await press('return');
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.equal((await mac.files.readInstall())?.paused, undefined);
  assert.match(text(), /\n╭─ ВОРКЕР · Google Apps Script {3,}● активен\n/);
  assert.match(text(), /\n┃ Проверить сейчас {3}Починить {3}Пауза\n/);
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}Снять с паузы: Воркер снят с паузы: расписание/);
  assert.match(text(), /вернулось\./);
});

test('«Починить» after «Пауза» from the screen puts the code in and leaves the schedule off', async () => {
  const { project, gas, screen, press, text } = await opened();
  const worker = project.files.find(file => file.name === 'worker');
  assert.ok(worker);
  const source = worker.source;
  worker.source = '// changed by hand\n';
  await press('tab', 'right', 'right', 'return');
  assert.match(text(), /\n╭╌ ВОРКЕР · Google Apps Script {3,}● на паузе\n/);

  await press('left', 'return', 'left');
  assert.equal(screen.busy, null);
  assert.equal(project.files.find(file => file.name === 'worker')?.source, source);
  assert.deepEqual(gas.triggers, [], 'the repair does not bring the schedule back');
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}Пауза: Воркер на паузе: расписание снято/);
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}Починить: Воркер починен: залита версия/);
  assert.match(text(), /осталось снятым\./);
});

// The screen polls the worker in its web app: a doPost is a POST and the GET of its redirect;
// the POSTs are counted.
const webAppPolls = (world: { google: { requests: { method: string; url: string }[] } }) =>
  world.google.requests.filter(r => r.method === 'POST' && r.url.includes('/macros/')).length;

test('the screen «Воркер» polls Google every 30 s while it is open and stops on the resets and on close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { world, screen, press } = await openedOnGoogle();
  await press('tab');
  const opened = webAppPolls(world);
  t.mock.timers.tick(29_999);
  await screen.polling;
  assert.equal(webAppPolls(world), opened);
  t.mock.timers.tick(1);
  await screen.polling;
  assert.equal(webAppPolls(world), opened + 1);
  t.mock.timers.tick(30_000);
  await screen.polling;
  assert.equal(webAppPolls(world), opened + 2);

  await press('tab');
  const onResets = webAppPolls(world);
  t.mock.timers.tick(5 * 30_000);
  await screen.polling;
  assert.equal(webAppPolls(world), onResets, 'no poll while the resets are shown');

  await press('tab');
  const again = webAppPolls(world);
  assert.equal(await screen.press({ name: 'q', sequence: 'q' }), 'exit');
  t.mock.timers.tick(5 * 30_000);
  await screen.polling;
  assert.equal(webAppPolls(world), again, 'no poll after the screen closed');
});

test('a poll that got no answer keeps the journal and says why over it', async () => {
  const { project, screen, press, text } = await openedOnGoogle();
  await press('tab');
  const [deploymentId] = [...project.deployments.keys()];
  assert.ok(deploymentId);
  project.deployments.delete(deploymentId);
  await press('r');
  assert.match(text(), /\n╭─ ЖУРНАЛ {3,}воркер не ответил · [\d:]+\n[┃│] Ошибка Google[^\n]*\n[┃│] 12:00 {2}вы {2}пробная проверка — применять нечего\n/);
  assert.equal(screen.frame().at(-1), WORKER_HINT, 'the screen stays');
});

test('the emails of the accounts come from the sign-ins; an install from before them names the accounts unknown', async () => {
  const { mac, run, screen, press, text } = await opened();
  assert.deepEqual((await mac.files.readInstall())?.accounts, { google: 'owner@example.invalid', chatgpt: 'fake@example.invalid' },
    'setup keeps the emails of the Google sign-in and of the ChatGPT id_token');
  const install = await mac.files.readInstall();
  assert.ok(install);
  const { accounts: _accounts, ...before } = install;
  await mac.files.writeInstall(before);
  await press('tab');
  assert.match(text(), /\n│ Google {4}аккаунт неизвестен · вход работает {3,}войти заново\n/);
  assert.match(text(), /\n│ ChatGPT {3}аккаунт неизвестен · вход работает {3,}войти заново\n/);

  // `aures login` keeps the email of its new session; so does «войти заново» on the screen.
  const { code, io } = await run(login);
  assert.equal(code, 0, io.output());
  assert.deepEqual((await mac.files.readInstall())?.accounts, { chatgpt: 'fake@example.invalid' });
  await mac.files.writeInstall(before);
  await press('up', 'return');
  assert.equal(screen.busy, null);
  assert.match(text(), /\n[┃│] [\d:–]+ +вы +ChatGPT: Вход обновлён, правила и история на месте\./);
  assert.match(text(), /\n┃ ChatGPT {3}fake@example\.invalid · вход работает/);
});

test('a Google grant without the email scope is no broken grant: setup goes on and the account reads as unknown', async () => {
  const env = await cliWorld();
  env.world.google.grantsEmail = false;
  const { code, io } = await env.run(setup, { answers: [] });
  assert.equal(code, 0, io.output());
  // The stage's ✓ names no account (issue 30): the grant gave no email to name.
  assert.match(io.output(), /\[1\/4\] Вход в Google\n.*\n {6}✓ вход выполнен\n/);
  assert.equal((await env.mac.files.readInstall())?.accounts?.google, undefined);
  let screen: Screen | undefined;
  await env.run(async options => { screen = await openScreen(options); screen.motion = false; return 0; });
  assert.ok(screen);
  await screen.press({ name: 'tab' });
  assert.match(screen.frame().join('\n'), /\n│ Google {4}аккаунт неизвестен · вход работает {3,}войти заново\n/);
  assert.deepEqual(env.world.google.violations, []);
});

test('«Войти заново» for Google in another account signs the CLI in anew, keeps the email and ends the grant before it', async () => {
  const { world, googleKeychain, mac, screen, press, text } = await openedOnGoogle();
  const before = await googleKeychain.read();
  assert.ok(before && world.google.refreshTokens.has(before));
  world.google.email = 'other@example.invalid';
  await press('tab', 'up', 'up', 'return');
  assert.equal(screen.busy, null);
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}Google: Вы вошли в Google как other@example\.invalid\./);
  assert.equal((await mac.files.readInstall())?.accounts?.google, 'other@example.invalid');
  assert.notEqual(await googleKeychain.read(), before);
  assert.equal(world.google.refreshTokens.has(before), false);
});

// Google ends the whole grant of the account on a revocation: revoking the token before a
// sign-in in the same account would end the new one too.
test('«Войти заново» for Google in the same account keeps the new sign-in working', async () => {
  const { world, googleKeychain, screen, press, text } = await openedOnGoogle();
  const before = await googleKeychain.read();
  assert.ok(before);
  await press('tab', 'up', 'up', 'return');
  assert.equal(screen.busy, null);
  assert.match(text(), /\n[┃│] 12:\d\d {2}вы {2}Google: Вы вошли в Google как owner@example\.invalid\./);
  const renewed = await googleKeychain.read();
  assert.ok(renewed && renewed !== before && world.google.refreshTokens.has(renewed));
  await press('r');
  assert.match(text(), /\n┃ Google {4}owner@example\.invalid · вход работает {3,}войти заново\n/);
});

test('a Google sign-in that Google no longer takes reads as lost, «войти заново» brings it back', async () => {
  const { world, googleKeychain, press, text } = await openedOnGoogle();
  const before = await googleKeychain.read();
  assert.ok(before);
  // Revoked in the Google account, or expired: the worker runs on, only the CLI's grant is gone.
  world.google.refreshTokens.delete(before);
  await press('tab', 'r');
  assert.match(text(), /\n│ Google {4}owner@example\.invalid · вход потерян {3,}войти заново\n/);
  assert.match(text(), /\n│ ChatGPT {3}fake@example\.invalid · вход работает/);
  await press('up', 'up', 'return');
  assert.match(text(), /\n┃ Google {4}owner@example\.invalid · вход работает {3,}войти заново\n/);
});

test('in a narrow terminal the journal folds to its width and scrolls down to its oldest line', async () => {
  const { screen, press } = await opened();
  await press('tab');
  for (let i = 1; i <= 6; i++) screen.steps.push({ at: screen.now() + i, text: `Шаг ${i}: длинный текст, который в узком терминале складывается в несколько строк.`, tone: 'ok' });
  screen.frame(40);
  await press('down', ...Array<string>(30).fill('pagedown'));
  const window = screen.frame(40).join('\n');
  assert.match(window, /вход в ChatGPT — сессия/, 'the oldest run in view');
  assert.match(window, /воркера обновлена/, 'the oldest run in view, folded under its column');
  assert.doesNotMatch(window, /Шаг 6/, 'the newest step scrolled away');
});

test('the section ВОРКЕР on the resets: the label on the right, the detail under it, the link only in status', async () => {
  const { world, mac, project, gas, screen, text, run } = await opened();
  assert.match(text(), /\n╭─ ВОРКЕР · Google Apps Script {3,}● активен\n│ ждёт запуска по расписанию\n╰─\n/);
  assert.doesNotMatch(text(), /script\.google\.com\/home/, 'the screen has no link: the screen «Воркер» has it');
  const { io } = await run(status);
  assert.ok(io.output().endsWith(`\n╭─ ВОРКЕР · Google Apps Script${' '.repeat(33)}● активен\n│ ждёт запуска по расписанию\n` +
    `│ https://script.google.com/home/projects/${project.scriptId}\n╰─`), 'status keeps the link as the last line of the section');

  // A pause: the label says it, the section has no detail line.
  const install = await mac.files.readInstall();
  assert.ok(install);
  await mac.files.writeInstall({ ...install, paused: true });
  await screen.load();
  assert.match(text(), /\n╭╌ ВОРКЕР · Google Apps Script {3,}● на паузе\n╰╌\n/);
  await mac.files.writeInstall(install);

  // A failed last run: the label names it in short, the detail carries the time.
  world.endSession('refresh_token_invalidated');
  world.advance(HOUR);
  assert.throws(() => gas.tick(), 'the tick throws, so that Google mails the user');
  await screen.load();
  assert.match(text(), /\n╭─ ВОРКЕР · Google Apps Script {3,}● ошибка запуска\n│ последний запуск с ошибкой · 20 окт 13:00\n╰─\n/);
});

test('the caption of an action does not open by itself with the screen or after an action', async () => {
  const { world, screen, press } = await opened();
  await press('tab');
  assert.equal(caption(screen.frame()), '', 'not with the screen');
  world.advance(60_000);
  assert.equal(caption(screen.frame()), '', 'not by time alone after Tab');
  await press('return'); // «Проверить сейчас» runs
  world.advance(60_000);
  assert.equal(caption(screen.frame()), '', 'not right after the action');
  await press('right'); // a key brings the cursor back on the row
  assert.equal(caption(screen.frame()), '', 'a new dwell starts');
  world.advance(400);
  assert.equal(caption(screen.frame()).startsWith('Заново залить'), true, 'and after 400 ms it opens');
});

// Issue 04: what moves on the screen, drawn from the moments the Screen keeps and the fake clock.
// The style a painted line gives the first cell that shows mark.
const styleOf = (painted: string, mark: string): string | null => {
  for (const [, style, text] of painted.matchAll(/\x1b\[([0-9;]+)m([^\x1b]*)\x1b\[0m/g)) if (text?.includes(mark)) return style ?? null;
  return null;
};
// The lines of the bracket of a section in a plain frame, from its heading to its corner.
const bracket = (frame: string[], title: string): string[] => {
  const from = frame.findIndex(line => /^[╭┏]/.test(line) && line.includes(title));
  const to = frame.findIndex((line, i) => i > from && /^[╰┗]/.test(line));
  return frame.slice(from, to + 1);
};
// The lit cells of a bracket; the row of actions under the cursor is heavy of its own.
const lit = (lines: string[]): number => lines.filter(line => /^[┃┏┗]/.test(line) && !line.includes('Проверить сейчас')).length;

test('the rule under the header counts down to the next scheduled run, and flashes when a new one comes', async () => {
  const { world, screen, gas } = await openedOnGoogle();
  gas.tick(); // a scheduled run
  await screen.load();
  screen.motion = true;
  world.advance(150_000); // 2.5 of 5 minutes
  assert.equal(screen.frame()[1], '━'.repeat(36) + '╸' + '─'.repeat(35));
  assert.match(text(screen), /следующий запуск ожидается через 2 мин/, 'the detail counts from the same run');
  world.advance(180_000);
  assert.equal(screen.frame()[1], '━'.repeat(72), 'past the end and no new run: all heavy, no end mark');

  gas.tick();
  await screen.load();
  assert.equal(styleOf(screen.frame(72, true)[1] ?? '', '━'), '1', 'a new run flashes the rule bold');
  world.advance(600);
  assert.equal(styleOf(screen.frame(72, true)[1] ?? '', '━'), null, 'the flash is over');
  assert.match(screen.frame()[1] ?? '', /^╸─+$/, 'and the countdown starts again');
});
const text = (screen: Screen): string => screen.frame().join('\n');

test('a pause dashes all of the rule under the header', async () => {
  const { screen, mac } = await opened();
  const install = await mac.files.readInstall();
  assert.ok(install);
  await mac.files.writeInstall({ ...install, paused: true });
  await screen.load();
  assert.equal(screen.frame()[1], '╌'.repeat(72));
});

test('the runner of a read: it eases down the journal, leaves after the answer, stops yellow without one', async () => {
  const { world, screen, press } = await openedOnGoogle();
  await press('tab');
  screen.motion = true;
  world.advance(EXIT_MS_PASSED);
  assert.equal(lit(bracket(screen.frame(), 'ЖУРНАЛ')), 0, 'the read of Tab has answered and gone');

  screen.poll = { at: world.now, answered: null, failed: false };
  world.advance(300);
  const flying = bracket(screen.frame(), 'ЖУРНАЛ');
  const at = flying.findIndex(line => /^[┃┏┗]/.test(line));
  assert.ok(at >= 0 && at < flying.length / 2, `the runner in the upper half:\n${flying.join('\n')}`);
  screen.poll.answered = world.now;
  world.advance(200);
  assert.equal(lit(bracket(screen.frame(), 'ЖУРНАЛ')), 0, 'gone 200 ms after the answer');

  screen.poll = { at: world.now, answered: null, failed: false };
  world.advance(4100);
  const painted = screen.frame(72, true).find(line => /^\x1b\[[0-9;]+m[┃┏┗]/.test(line) && !line.includes('Проверить'));
  assert.equal(styleOf(painted ?? '', painted?.includes('┏') ? '┏' : '┃'), S_YELLOW, 'no answer in 4 s: yellow');
  world.advance(10_000);
  assert.ok(lit(bracket(screen.frame(), 'ЖУРНАЛ')) > 0, 'and it stands');
  await screen.loadWorker();
  world.advance(200);
  assert.equal(lit(bracket(screen.frame(), 'ЖУРНАЛ')), 0, 'a new read takes it away');
});
const EXIT_MS_PASSED = 200, S_YELLOW = '33', S_GREEN = '32', S_CYAN = '1;36';

test('an action fills the bracket of its section as it goes, goes round it without a usual time, and its outcome lights it', async () => {
  const { world, screen, press } = await openedOnGoogle();
  await press('tab');
  screen.motion = true;
  world.advance(1000);
  const cells = bracket(screen.frame(), 'ВОРКЕР').length;

  screen.busy = 'Проверяем воркер…';
  screen.running = { at: world.now, section: 'worker', expected: 4000 };
  world.advance(2000);
  const half = bracket(screen.frame(), 'ВОРКЕР');
  assert.equal(lit(half), Math.floor(cells / 2), half.join('\n'));
  assert.ok(half[Math.floor(cells / 2)]?.startsWith('╏'), 'the cell where it is');
  assert.equal(styleOf(screen.frame(72, true)[3] ?? '', '┏━'), S_CYAN);
  assert.equal(screen.frame().at(-1), 'Проверяем воркер…  0:02', 'no spinner: what is done and for how long');
  assert.ok(screen.frame().every(line => !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)));

  screen.running = { at: world.now, section: 'worker', expected: null }; // «войти заново»
  world.advance(250);
  const round = bracket(screen.frame(), 'ВОРКЕР');
  assert.deepEqual(round.slice(0, 3).map(line => line.charAt(0)), ['╭', '┃', '┃'], 'a runner, its head two cells down');
  world.advance(100);
  assert.deepEqual(bracket(screen.frame(), 'ВОРКЕР').slice(0, 4).map(line => line.charAt(0)), ['╭', '╏', '┃', '┃'], 'it goes on');
  screen.busy = null;
  screen.running = null;

  await press('return'); // «Проверить сейчас» on Google answers at once
  assert.equal(lit(bracket(screen.frame(), 'ВОРКЕР')), cells - 1, 'a good outcome lights the whole bracket');
  assert.equal(styleOf(screen.frame(72, true)[3] ?? '', '┏━'), S_GREEN);
  world.advance(600);
  assert.equal(lit(bracket(screen.frame(), 'ВОРКЕР')), 0, 'for 600 ms');

  screen.outcome = { at: world.now, section: 'worker', ok: false };
  world.advance(1000);
  assert.equal(styleOf(screen.frame(72, true)[3] ?? '', '┏━'), S_YELLOW, 'a bad one is yellow, and longer');
  world.advance(500);
  assert.equal(lit(bracket(screen.frame(), 'ВОРКЕР')), 0);
});

test('the dot of an active worker breathes with motion; on pause the bracket is dashed and the dot still', async () => {
  const { world, screen, mac } = await opened();
  const dot = () => styleOf(screen.frame(72, true).find(line => line.includes('ВОРКЕР')) ?? '', '●');
  assert.equal(dot(), S_GREEN, 'without motion the dot stands');
  screen.motion = true;
  const breath = new Set<string | null>();
  for (let i = 0; i < 4; i++) { breath.add(dot()); world.advance(1000); }
  assert.deepEqual([...breath].sort(), ['1;32', '2;32', '32'], 'a step a second');

  const install = await mac.files.readInstall();
  assert.ok(install);
  await mac.files.writeInstall({ ...install, paused: true });
  await screen.load();
  assert.match(text(screen), /\n╭╌ ВОРКЕР · Google Apps Script {3,}● на паузе\n╰╌\n/);
  const still = dot();
  world.advance(1000);
  assert.equal(dot(), still);
  assert.equal(still, S_YELLOW);
});

test('the caption unrolls line by line after its dwell and rolls back up; without motion it is there at once', async () => {
  const { world, screen, press } = await openedOnGoogle();
  await press('tab');
  screen.motion = true;
  await press('right');
  world.advance(400);
  assert.equal(caption(screen.frame()), '', 'the dwell has passed: only the rule is there yet');
  assert.match(text(screen), /\n│ {20}╍{8}\n/, 'and it is not drawn yet');
  world.advance(60);
  assert.equal(caption(screen.frame()), 'Заново залить текущую версию воркера и вернуть расписание. Сбросы,', 'one line in 60 ms');
  world.advance(120);
  assert.match(text(screen), /\n│ {20}━{8}\n/, 'the rule is drawn in 180 ms');
  assert.equal(caption(screen.frame()), REPAIR_CAPTION, 'all three lines in 400 + 60·3 ms');

  await press('up');
  assert.equal(caption(screen.frame()), REPAIR_CAPTION, 'closing starts from all of it');
  world.advance(60);
  assert.equal(screen.frame().filter(line => /^│ {3}\S/.test(line)).length, 2, 'a line goes in 60 ms, from the bottom');
  world.advance(180);
  assert.equal(caption(screen.frame()), '');
  assert.doesNotMatch(text(screen), /[━╍]{8}/, 'and the rule with the last one');

  screen.motion = false;
  await press('down');
  world.advance(400);
  assert.equal(caption(screen.frame()), REPAIR_CAPTION, 'without motion all of it at once after the dwell');
});

test('without motion the frames do not move: no runner, no fill, no flash, no breath', async () => {
  const { world, screen, press } = await openedOnGoogle();
  await press('tab');
  screen.poll = { at: world.now, answered: null, failed: false };
  screen.outcome = { at: world.now, section: 'worker', ok: true };
  screen.flashAt = world.now;
  const before = screen.frame(72, true);
  world.advance(300);
  assert.deepEqual(screen.frame(72, true), before);
  assert.equal(lit(bracket(screen.frame(), 'ЖУРНАЛ')) + lit(bracket(screen.frame(), 'ВОРКЕР')), 0);
});
