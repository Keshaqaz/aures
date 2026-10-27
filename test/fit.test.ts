import test from 'node:test';
import assert from 'node:assert/strict';
import { fit, fitOnRail, foldText } from '../src/cli/fit.ts';
import type { Segment } from '../src/cli/fit.ts';
import { renderOverview } from '../src/cli/overview.ts';
import type { Overview } from '../src/cli/overview.ts';
import { setLanguage } from '../src/cli/language.ts';

const text = (rows: Segment[][]): string[] => rows.map(row => row.map(([part]) => part).join(''));

test('a short line stays as it is', () => {
  const line: Segment[] = [['  short', '2']];
  assert.deepEqual(fit(line, 20), [line]);
});

test('a long line folds at a space and goes on under its indent, never wider than the width', () => {
  const rows = text(fit([['  one two three four five six', '']], 14));
  assert.deepEqual(rows, ['  one two', '  three four', '  five six']);
  assert.ok(rows.every(row => [...row].length <= 14));
});

test('a journal line goes on under its text, after the time column', () => {
  const rows = text(fit([['  24 Oct 23:40  ', '2'], ['aures · Check now: the worker works, resets: 1', '']], 34));
  assert.deepEqual(rows, ['  24 Oct 23:40  aures · Check now:', '                the worker works,', '                resets: 1']);
});

test('a link longer than a line folds after a «/», under its indent', () => {
  const rows = text(fit([['  https://script.google.com/home/projects/1saDvTvdkGxbE8lZW7Qi37qq', '2']], 30));
  assert.deepEqual(rows, ['  https://script.google.com/', '  home/projects/1saDvTvdkGxbE8', '  lZW7Qi37qq']);
});

test('the marks of a line count as its indent', () => {
  assert.deepEqual(foldText('! The rules do not read. Choose them again', 22), ['! The rules do not', '  read. Choose them', '  again']);
});

test('each part keeps its style across the fold; a time column wider than half the line falls back to the indent', () => {
  const rows = fit([['  23:40  ', '2'], ['run', ''], [' · 0,7 s', '2']], 14);
  assert.deepEqual(rows, [[['  23:40  ', '2'], ['run', ''], [' ·', '2']], [['  ', ''], ['0,7 s', '2']]]);
});

test('a scrap at the end (the unit of a duration) stays with the word before it', () => {
  assert.deepEqual(text(fit([['  20 Oct 12:00  ', '2'], ['trial · nothing to apply', ''], [' · 0,0 s', '2']], 44)),
    ['  20 Oct 12:00  trial · nothing to apply ·', '                0,0 s']);
});

test('a hint folds after a «·», keeping each key with its word', () => {
  assert.deepEqual(foldText('↑↓ select · Enter run · Tab resets · l language · r refresh · q quit', 52),
    ['↑↓ select · Enter run · Tab resets · l language ·', 'r refresh · q quit']);
});

// The worker Google has never run on schedule (issue 04): its label on the heading of the
// section and the detail under it need no fold, and the warning under them folds, both in the
// width of the screen and in both languages.
test('the mark of a never-scheduled worker and its warning fit the width in both languages', () => {
  const readAt = Date.parse('2026-10-20T12:42:00.000Z');
  const model: Overview = { worker: { platform: 'google', scriptId: '1saDvTvdkGxbE8lZW7Qi37qq', schedule: true,
    journal: [{ at: '2026-10-20T10:40:00.000Z', kind: 'login', outcome: 'idle', durationMs: 200 },
      { at: '2026-10-20T10:41:00.000Z', kind: 'trial', outcome: 'idle', durationMs: 300 }] },
    readAt, resets: [], rules: null, paused: false, lastApplied: null, lastAttempt: null };
  const plain = (line: Segment[]): string => line.map(([text]) => text).join('');
  try {
    for (const code of ['en', 'ru'] as const) {
      setLanguage(code);
      const lines = renderOverview(model, { now: () => readAt, timeZone: 'UTC' }).map(plain);
      const heading = lines.findIndex(line => line.includes(code === 'ru' ? 'ВОРКЕР' : 'WORKER'));
      assert.match(lines[heading] ?? '', code === 'ru' ? /● нет запусков по расписанию$/ : /● no scheduled run$/);
      assert.ok([...lines[heading] ?? ''].length <= 72, 'the label fits the heading without a fold');
      assert.match(lines[heading + 1] ?? '', code === 'ru' ? /уже 2 ч$/ : /none for 2h$/);
      assert.ok([...lines[heading + 1] ?? ''].length <= 72, 'the detail fits its line without a fold');
      const warning = lines.at(-1) ?? '';
      assert.ok(warning.startsWith('! '), 'the warning stands under the sections');
      for (const row of fitOnRail([['! ', ''], [warning.slice(2), '']], 72)) {
        const text = plain(row);
        assert.ok([...text].length <= 72, `${code}: ${text}`);
      }
    }
  } finally { setLanguage('en'); }
});
