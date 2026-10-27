import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { Fetch } from '../chatgpt/http.ts';
import { RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import { revokeGoogle } from '../google/api.ts';
import { CommandFailed, resetName, explain, command } from './common.ts';
import { applyReset, readyToApply } from './apply-now.ts';
import { saveRules, storedRules } from './rules.ts';
import { openWorker } from './active-worker.ts';
import type { Worker, OpenWorkerOptions } from './active-worker.ts';
import type { Io, Rule, Sleep } from './common.ts';
import { fitOnRail } from './fit.ts';
import type { Segment } from './fit.ts';
import { readOverview, renderOverview, overviewItems, sameItem, headerLine, ruleLine, countdown, lastScheduled, workerTone, lastRunFailed,
  paint, S, WIDTH } from './overview.ts';
import type { Overview, Tone as OverviewTone } from './overview.ts';
import { readWorkerPage, renderWorker, itemLabel, POLL_MS, workerItems, FIRST_ACTION, journalHeight, journalWindow,
  captionHeight } from './worker-screen.ts';
import type { WorkerPage, WorkerItem, Step, Unrolled } from './worker-screen.ts';
import { trialLine } from './setup-google.ts';
import type { Trial } from './setup-google.ts';
import { repairWorker } from './repair.ts';
import { setWorkerPause } from './pause.ts';
import { signInAgain, renewed } from './login.ts';
import { connectGoogle, readSecret } from './google.ts';
import type { Keychain } from './keychain.ts';
import type { OpenUrl, CopyText } from './browser.ts';
import type { Mac } from './common.ts';
import { t, language, setLanguage } from './language.ts';

// `aures` without a command: the overview of `status` with a cursor. Enter on a
// reset applies it now after a «y», Enter on a rule switches it; both do what `apply-now` and
// `rules` do. Tab opens the screen «Воркер» and goes back: there Enter signs an account in
// again, checks the worker with a trial run, repairs it, pauses it or takes it off pause, and the
// journal under it is polled while it is shown. l switches the language between English
// and Russian and keeps the choice. Takes the whole terminal on its alternate screen; q gives
// the terminal back as it was.
const hint = (): string => t('↑↓ select · Enter apply · Tab worker · l language · r refresh · q quit',
  '↑↓ выбор · Enter применить · Tab воркер · l язык · r обновить · q выход');
const workerHint = (): string => t('↑↓←→ select · Enter run · Tab resets · l language · r refresh · q quit',
  '↑↓←→ выбор · Enter действие · Tab сбросы · l язык · r обновить · q выход');
// What the keys do while the cursor stands in the journal of the screen «Воркер».
const scrollHint = (): string => t('↑↓ scroll · PgUp PgDn page · Home newest · Esc actions · q quit',
  '↑↓ листать · PgUp PgDn страница · Home свежие · Esc действия · q выход');
type Tone = Exclude<OverviewTone, 'bad'>;
const TONES: Record<Tone, string> = { ok: S.green, warn: S.yellow };
const MARGIN = '  ';
// How long the cursor has to stand on an action before its caption opens (issue 03).
const CAPTION_MS = 400;
// What moves on the screen and how fast (issue 04): the rule of a caption is drawn in RULE_MS and
// its lines come and go one in LINE_MS; a new scheduled run flashes the rule under the header for
// FLASH_MS, an outcome lights its bracket for FLASH_MS, or WARN_MS when it needs a look. The
// runner of a poll eases down the journal's bracket by EASE_MS, leaves it in EXIT_MS after the
// answer and stops after STUCK_MS without one; a runner that goes round takes STEP_MS a cell.
const RULE_MS = 180, LINE_MS = 60, FLASH_MS = 600, WARN_MS = 1500, EASE_MS = 600, EXIT_MS = 200, STUCK_MS = 4000, STEP_MS = 100;
// The dot of an active worker breathes: a step a second.
const BREATH = ['2;32', '32', '1;32', '32'];

// The sections of a frame by the titles of their brackets: where the runners go (issue 04).
type Section = 'resets' | 'rules' | 'worker' | 'journal';
const TITLES: Record<Section, () => string> = { resets: () => t('RESETS', 'СБРОСЫ'), rules: () => t('RULES', 'ПРАВИЛА'),
  worker: () => t('WORKER', 'ВОРКЕР'), journal: () => t('JOURNAL', 'ЖУРНАЛ') };
// The cells of the bracket of a section, top to bottom: its lines from the heading to the corner.
function bracketOf(lines: Segment[][], section: Section): number[] {
  const title = TITLES[section]();
  const from = lines.findIndex(line => line[0]?.[0].startsWith('╭') && line[1]?.[0] === title);
  const to = lines.findIndex((line, i) => i > from && line[0]?.[0].startsWith('╰'));
  return from < 0 || to < 0 ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
// A cell of a bracket lit: heavy (┃, ┏━ and ┗━ on the corners) or the dotted tail behind (╏).
function light(line: Segment[] | undefined, kind: 'lit' | 'tail', style: string): void {
  if (!line) return;
  const text = line[0]?.[0] ?? '';
  const mark = text.startsWith('╭') ? kind === 'lit' ? '┏━' : '╭╍' : text.startsWith('╰') ? kind === 'lit' ? '┗━' : '╰╍' :
    kind === 'lit' ? '┃' : '╏';
  line[0] = [mark + [...text].slice([...mark].length).join(''), style];
}
// A runner on a bracket: two lit cells with its head at head, a tail cell behind them.
function runner(lines: Segment[][], cells: number[], head: number, style: string, tail: string): void {
  const at = Math.floor(head);
  for (const [i, kind] of [[at, 'lit'], [at - 1, 'lit'], [at - 2, 'tail']] as const) {
    const line = cells[i];
    if (line !== undefined) light(lines[line], kind, kind === 'lit' ? style : tail);
  }
}
// «1:05» since an action started.
const elapsed = (ms: number): string => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
// The same keys on the Russian layout.
const RUSSIAN: Record<string, string> = { н: 'y', й: 'q', к: 'r', о: 'j', л: 'k', д: 'l' };

// What an action says: a line of a note, or of its message, in its tone.
export type Note = (text: string, tone?: Tone) => void;
// What the screen «Воркер» needs on top: the sign-ins it renews, the bundle «Починить» deploys
// (null without a build) and reopen, which opens the worker again after a deploy.
export interface ScreenOptions {
  worker: Worker;
  mac: Mac;
  fetch: Fetch;
  now: () => number;
  sleep: Sleep;
  timeZone: string | undefined;
  googleKeychain: Keychain;
  secretKeychain: Keychain;
  open: OpenUrl;
  copy: CopyText;
  appsScriptSource: string | null;
  reopen: () => Promise<Worker>;
}
export type View = 'resets' | 'worker';

// The screen without the terminal: keys in, frames out.
export class Screen {
  worker: Worker;
  mac: Mac;
  fetch: Fetch;
  now: () => number;
  sleep: Sleep;
  timeZone: string | undefined;
  model: Overview | null = null;
  cursor = 0;
  confirm: string | null = null; // the reset waiting for «y»
  busy: string | null = null; // what is being done
  notes: { text: string; tone: Tone | undefined }[] = []; // what the last action said
  said: OverviewTone | undefined = undefined; // the tone of what the action under way said last
  changed: () => void = () => {};
  options: ScreenOptions;
  view: View = 'resets';
  page: WorkerPage | null = null; // the screen «Воркер» as last read
  workerCursor = FIRST_ACTION;
  actionCursor = FIRST_ACTION; // the action the row chose last, where ↓ from ChatGPT lands
  journal = false; // the cursor stands in the journal, not on the items
  journalOffset = 0; // how far the journal window is scrolled, in visual lines
  caption = false; // the caption of the action under the cursor is open and stays open over its neighbours
  actionAt: number | null = null; // when the cursor came on the row of actions by a key
  // What moves is drawn from the moments below and now (issue 04); off, the frames stand still.
  motion = true;
  // The caption as it unrolls from a moment on: from lines it showed then towards all of them, or
  // back to none when it closes.
  unroll: { item: WorkerItem; at: number; from: number; open: boolean } | null = null;
  poll: { at: number; answered: number | null; failed: boolean } | null = null; // the last read of the screen «Воркер»
  running: { at: number; section: Section | null; expected: number | null } | null = null; // the action under way
  outcome: { at: number; section: Section; ok: boolean } | null = null; // how the last action ended
  scheduledAt: number | null = null; // the latest scheduled run seen
  flashAt: number | null = null; // when a new scheduled run was seen
  selectedLine = -1; // the line of the last frame the cursor stands on (issue 33)
  throughLine = -1; // the last line of the frame that belongs to it: an open caption ends there
  width = WIDTH; // the width of the last frame: the journal folds and scrolls to it
  steps: Step[] = []; // what the CLI did on the screen «Воркер», for its journal
  polling: Promise<void> | null = null; // the poll under way
  poller: ReturnType<typeof setInterval> | null = null;
  constructor(options: ScreenOptions) {
    const { worker, mac, fetch, now, sleep, timeZone } = options;
    this.options = options;
    this.worker = worker;
    this.mac = mac;
    this.fetch = fetch;
    this.now = now;
    this.sleep = sleep;
    this.timeZone = timeZone;
  }

  // Reads the overview again. The cursor stays on its item; when its reset is gone, on the
  // nearest reset, so that the next Enter never switches a rule by mistake.
  async load(): Promise<void> {
    const was = this.model ? overviewItems(this.model)[this.cursor] : undefined;
    this.model = await readOverview(this);
    const items = overviewItems(this.model), resets = items.filter(item => item.kind === 'reset').length;
    const same = items.findIndex(item => sameItem(item, was));
    this.cursor = same >= 0 ? same : was?.kind === 'reset' && resets ? Math.min(this.cursor, resets - 1) :
      Math.min(this.cursor, Math.max(0, items.length - 1));
    this.seeSchedule();
  }

  // The latest scheduled run in the journal of the screen «Воркер».
  pageScheduled(): number | null {
    return this.page ? lastScheduled(this.page.journal?.entries ?? []) : null;
  }

  // A scheduled run later than the latest seen flashes the rule under the header (issue 04).
  seeSchedule(): void {
    const at = this.model ? countdown(this.model, this.pageScheduled())?.from ?? null : null;
    if (at === null) return;
    if (this.scheduledAt !== null && at > this.scheduledAt) this.flashAt = this.now();
    this.scheduledAt = Math.max(at, this.scheduledAt ?? at);
  }

  // Reads the screen «Воркер» again. A poll that gets no answer keeps what the last one read and says why.
  async loadWorker(): Promise<void> {
    const before = this.journalLines().length;
    const { worker, mac, now, fetch, options: { googleKeychain } } = this;
    // The runner on the bracket of the journal is this read (issue 04).
    const poll: NonNullable<Screen['poll']> = { at: now(), answered: null, failed: false };
    this.poll = poll;
    try { this.page = await readWorkerPage({ worker, mac, now, fetch, googleKeychain }); } catch (error) {
      poll.failed = true;
      poll.answered = now();
      if (!this.page) throw error;
      this.page = { ...this.page, polledAt: this.now(), failed: explain(error) ?? t('unexpected error', 'неожиданная ошибка') };
    }
    poll.answered ??= now();
    this.seeSchedule();
    // The actions change with the state the page read.
    const last = workerItems().length - 1;
    this.workerCursor = Math.min(this.workerCursor, last);
    this.actionCursor = Math.min(this.actionCursor, last);
    this.syncJournal(before);
  }

  // The height of the journal window: the body of the screen «Воркер» as tall as the body of the
  // overview as the screen shows it (without the link only `status` has), with the window 3–10 rows.
  windowRows(): number {
    const body = this.model ? renderOverview(this.model, { now: this.now, timeZone: this.timeZone, toggle: true }).length : null;
    return journalHeight(body);
  }

  // The visual lines the journal window can scroll over at the moment. A poll that got no answer
  // pins its reason over the first of them, so the journal has one row fewer.
  journalLines(page: WorkerPage | null = this.page): Segment[][] {
    if (!page) return [];
    return journalWindow(page, this.steps, { timeZone: this.timeZone, now: this.now, width: this.width,
      lastApplied: this.model?.lastApplied ?? null });
  }

  // New lines come on top of the journal as it is polled; a window the user has scrolled stays
  // on its lines: the offset moves by as many visual lines as came on top of it.
  syncJournal(before: number): void {
    const page = this.page;
    if (!page || !this.journal || this.journalOffset <= 0) return;
    const after = this.journalLines(page).length;
    const viewport = this.windowRows() - (page.failed ? 1 : 0);
    this.journalOffset = Math.min(this.journalOffset + Math.max(0, after - before), Math.max(0, after - viewport));
  }

  // What the CLI did on this screen, as a line of its journal.
  step(text: string, tone: Step['tone'] = 'ok', at = this.now()): void {
    const before = this.journalLines().length;
    this.said = tone;
    this.steps.push({ at, text, tone });
    this.syncJournal(before);
  }

  // The worker is polled only while its screen is shown: Tab back to the resets and closing the screen stop it.
  startPolling(): void {
    this.stopPolling();
    this.poller = setInterval(() => {
      if (this.busy || this.polling || this.view !== 'worker') return;
      this.polling = this.loadWorker().catch(error => {
        if (this.page) this.page = { ...this.page, polledAt: this.now(), failed: explain(error) ?? String(error) };
      }).finally(() => {
        this.polling = null;
        this.changed();
      });
    }, POLL_MS);
    this.poller.unref?.();
  }
  stopPolling(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }
  // The screen closes: nothing goes on after it.
  close(): 'exit' {
    this.stopPolling();
    return 'exit';
  }

  // The caption of the action under the cursor (issue 03): it opens when the cursor has stood
  // on the row for 400 ms and stays open while the cursor walks the row; off the row, on opening
  // the screen and after an action it is closed until a key brings the cursor back.
  captionOpen(): boolean {
    if (this.view !== 'worker' || this.journal || this.workerCursor < FIRST_ACTION) return false;
    return this.caption || this.actionAt !== null && this.now() - this.actionAt >= CAPTION_MS;
  }

  // The caption as the frame draws it at the moment (issue 04): its rule drawn in RULE_MS, its
  // lines coming one in LINE_MS — and going so when it closes. Without motion it is all there.
  captionView(): Unrolled | null {
    if (this.view !== 'worker' || !this.page) return null;
    if (!this.motion) {
      const item = this.captionOpen() ? workerItems()[this.workerCursor] : undefined;
      return item === undefined ? null : { item, rule: 1, lines: Infinity };
    }
    const unroll = this.unroll, now = this.now();
    if (!unroll || now < unroll.at) return null;
    const steps = Math.floor((now - unroll.at) / LINE_MS);
    if (!unroll.open) {
      const lines = Math.max(0, unroll.from - steps);
      return lines ? { item: unroll.item, rule: 1, lines } : null;
    }
    const height = captionHeight(unroll.item, this.page.paused, this.width);
    return { item: unroll.item, rule: Math.min(1, (now - unroll.at) / RULE_MS),
      lines: unroll.from <= height ? Math.min(height, unroll.from + steps) : Math.max(height, unroll.from - steps) };
  }

  // Whether the frame changes with time alone, so the terminal redraws it: an action, a read of
  // the worker, a flash, a caption on its way, the breathing dot — or, standing still, a caption
  // waiting for its dwell.
  moving(): boolean {
    const now = this.now();
    if (this.busy) return true;
    if (this.view === 'worker' && this.actionAt !== null && !this.caption && now - this.actionAt <= CAPTION_MS + STEP_MS) return true;
    if (!this.motion) return false;
    const { unroll, poll, outcome, flashAt, page } = this;
    if (unroll && page && now - unroll.at <= RULE_MS + LINE_MS *
      (Math.max(unroll.from, captionHeight(unroll.item, page.paused, this.width)) + 1)) return true;
    if (poll && this.view === 'worker' && (poll.answered === null ? now - poll.at <= STUCK_MS + STEP_MS :
      !poll.failed && now - poll.answered <= EXIT_MS)) return true;
    if (outcome && now - outcome.at <= (outcome.ok ? FLASH_MS : WARN_MS) || flashAt !== null && now - flashAt <= FLASH_MS) return true;
    return this.model !== null && workerTone(this.model) === 'ok';
  }

  // What moves, over the lines of a frame (issue 04): the breathing dot of an active worker, the
  // flash of the rule under the header, the runner of a read on the bracket of the journal, an
  // action filling the bracket of its section or going round it, and the outcome lighting it.
  animate(lines: Segment[][], width: number): void {
    const now = this.now(), model = this.model;
    const heading = lines[bracketOf(lines, 'worker')[0] ?? -1];
    const dot = heading?.findIndex(([text, style]) => text === '● ' && style === S.green) ?? -1;
    if (heading && dot >= 0) heading[dot] = ['● ', BREATH[Math.floor(now / 1000) % BREATH.length] ?? S.green];
    if (this.flashAt !== null && now - this.flashAt < FLASH_MS) lines[1] = [['━'.repeat(width), S.bold]];

    const poll = this.poll, journal = bracketOf(lines, 'journal');
    if (poll && journal.length) {
      const ease = (ms: number) => journal.length * (1 - Math.exp(-ms / EASE_MS));
      const style = model?.paused ? S.dim : model && lastRunFailed(model) ? S.yellow : S.bold;
      if (poll.answered === null && now - poll.at <= STUCK_MS) runner(lines, journal, ease(now - poll.at), style, S.dim);
      else if (poll.answered === null || poll.failed) {
        runner(lines, journal, ease(Math.min(STUCK_MS, (poll.answered ?? Infinity) - poll.at)), S.yellow, S.dim);
      } else if (now - poll.answered < EXIT_MS) {
        const from = ease(poll.answered - poll.at);
        runner(lines, journal, from + (journal.length + 2 - from) * (now - poll.answered) / EXIT_MS, style, S.dim);
      }
    }

    const running = this.running, outcome = this.outcome;
    if (this.busy && running?.section) {
      const cells = bracketOf(lines, running.section), spent = now - running.at;
      if (running.expected && spent < running.expected) {
        const filled = Math.floor(cells.length * spent / running.expected);
        cells.forEach((line, i) => { if (i <= filled) light(lines[line], i < filled ? 'lit' : 'tail', S.cyan); });
      } else runner(lines, cells, Math.floor(spent / STEP_MS) % (cells.length + 2), S.cyan, S.cyan);
    } else if (outcome && now - outcome.at < (outcome.ok ? FLASH_MS : WARN_MS)) {
      for (const line of bracketOf(lines, outcome.section)) light(lines[line], 'lit', outcome.ok ? S.green : S.yellow);
    }
  }

  // Lines of the frame, painted when color. fold folds the long ones under their text (issue
  // 32), as the terminal needs; the lines themselves, as tests read them, stay whole. footer is
  // how many of the last lines are the foot: what an action said, its spinner or question, the
  // keys — what a frame taller than the terminal keeps in view (issue 33).
  footer = 0;
  frame(width = WIDTH, color = false, fold = color): string[] {
    this.width = width;
    const options = { now: this.now, timeZone: this.timeZone, width, toggle: true };
    let lines: Segment[][];
    if (this.view === 'worker') {
      // The rule under the header counts down from the latest scheduled run either screen read.
      const rule = ruleLine(this.model, { now: this.now, width, scheduledAt: this.pageScheduled() });
      lines = this.page ? renderWorker(this.page, { ...options, cursor: this.workerCursor, steps: this.steps, header: headerLine(options),
        rule, rows: this.windowRows(), offset: this.journalOffset, focus: this.journal, caption: this.captionView(),
        lastApplied: this.model?.lastApplied ?? null }) :
        [headerLine(options), rule];
    } else if (this.model) lines = renderOverview(this.model, { ...options, cursor: this.cursor });
    else return [];
    const body = lines.length;
    lines.push([]);
    for (const note of this.notes) lines.push([[note.text, note.tone ? TONES[note.tone] : '']]);
    if (this.notes.length) lines.push([]);
    // What is being done and for how long; its bracket shows how far it is (issue 04).
    if (this.busy) lines.push([[this.busy, ''], [`  ${elapsed(this.now() - (this.running?.at ?? this.now()))}`, S.dim]]);
    else if (this.confirm) {
      lines.push([[t(`Apply ${resetName(this.confirm)} now? A reset is single-use. `, `Применить ${resetName(this.confirm)} сейчас? Сброс одноразовый. `), S.bold],
        [t('y — yes, any other key — cancel', 'y — да, другая клавиша — отмена'), S.dim]]);
    } else lines.push([[this.view === 'worker' ? this.journal ? scrollHint() : workerHint() : hint(), S.dim]]);
    // The line the cursor stands on: the heavy rail of the chosen row, or — the journal being
    // focused — the cyan corner of its heading. A frame taller than the terminal keeps it in
    // view (issue 33), so its place is found as the lines fold.
    const picked = lines.slice(0, body).findIndex(([first]) =>
      (first?.[0] === '┃ ' && first[1] === S.cyan) || (first?.[0] === '╭─ ' && first[1] === S.cyan));
    // An open caption is what the user stopped on the action for: the frame keeps it in view
    // down to its last line, under the row it belongs to.
    const worker = this.view === 'worker' && !this.journal && this.captionView() ? bracketOf(lines, 'worker') : [];
    const through = (worker.at(-1) ?? picked + 1) - 1;
    if (this.motion) this.animate(lines, width);
    this.selectedLine = this.throughLine = -1;
    const folded: Segment[][] = [];
    const part = (from: number, to: number): Segment[][] => lines.slice(from, to).flatMap((line, i) => {
      const rows = fold ? fitOnRail(line, width) : [line];
      if (from + i === picked) this.selectedLine = folded.length;
      if (from + i === through && picked >= 0) this.throughLine = folded.length + rows.length - 1;
      folded.push(...rows);
      return rows;
    });
    const head = part(0, body), foot = part(body, lines.length);
    this.footer = foot.length;
    return [...head, ...foot].map(line => paint(line, color));
  }

  // Where the cursor is among the items of the shown screen: on the first, on the last, or
  // between them. A frame taller than the terminal shows its top or its bottom there (issue 33).
  edge(): 'first' | 'last' | null {
    if (this.view === 'worker' && this.journal) return 'last';
    const [at, count] = this.view === 'worker' ? [this.workerCursor, this.page ? workerItems().length : 0] :
      [this.cursor, this.model ? overviewItems(this.model).length : 0];
    return at === 0 ? 'first' : at === count - 1 ? 'last' : null;
  }

  // One key; resolves when what it started is done, to 'exit' when the screen closes.
  async press(key: Key): Promise<'exit' | undefined> {
    const sequence = key.sequence?.toLowerCase();
    const name = (sequence === undefined ? undefined : RUSSIAN[sequence]) ?? key.name;
    if (key.ctrl && name === 'c') return this.close();
    if (this.busy) return;
    if (this.confirm) {
      const creditId = this.confirm;
      this.confirm = null;
      if (name === 'y') {
        const name = resetName(creditId);
        return this.act(t(`Applying ${name}…`, `Применяем ${name}…`), note => this.apply(creditId, note), { section: 'resets' });
      }
      this.changed();
      return;
    }
    this.notes = [];
    if (name === 'q' || name === 'escape') {
      // In the journal Esc goes back to the actions; everywhere else it closes the screen.
      if (name === 'escape' && this.view === 'worker' && this.journal) return this.pressOnWorker(name);
      return this.close();
    }
    if (name === 'r') return this.act(t('Refreshing…', 'Обновляем…'), async () => {});
    if (name === 'l') return this.switchLanguage();
    if (name === 'tab') return this.switchView();
    if (this.view === 'worker') return this.pressOnWorker(name);
    const items = this.model ? overviewItems(this.model) : [], item = items[this.cursor];
    if ((name === 'up' || name === 'k') && items.length) this.cursor = (this.cursor + items.length - 1) % items.length;
    else if ((name === 'down' || name === 'j') && items.length) this.cursor = (this.cursor + 1) % items.length;
    else if ((name === 'return' || name === 'space') && item?.kind === 'reset') this.confirm = item.creditId;
    else if ((name === 'return' || name === 'space') && item?.kind === 'rule') {
      return this.act(t('Saving the rules…', 'Сохраняем правила…'), note => this.switchRule(item.rule, note), { section: 'rules', expected: 3_000 });
    }
    this.changed();
  }

  // Tab: the screen «Воркер», read anew and polled from now on, or back to the resets, read anew.
  // The screen «Воркер» opens on its first action, its journal unscrolled; the caption of the
  // action opens by dwell only, never with the screen itself.
  async switchView(): Promise<undefined> {
    this.caption = false;
    this.actionAt = null;
    this.unroll = null;
    if (this.view === 'worker') {
      this.stopPolling();
      this.view = 'resets';
      return this.act(t('Refreshing…', 'Обновляем…'), async () => {});
    }
    this.view = 'worker';
    this.journal = false;
    this.journalOffset = 0;
    this.workerCursor = this.actionCursor = FIRST_ACTION;
    await this.act(t('Reading the worker journal…', 'Читаем журнал воркера…'), async () => {});
    if (this.view === 'worker') this.startPolling();
  }

  // The keys of the screen «Воркер». The zones from top to bottom: the account of the platform,
  // ChatGPT, the row of actions, the journal. ↑ and ↓ walk the zones, ← and → the row; in the
  // journal they scroll the window and Enter does nothing. Nothing goes round.
  async pressOnWorker(name: string | undefined): Promise<undefined> {
    const page = this.page;
    if (!page) return;
    const items = workerItems(), count = items.length, item = items[this.workerCursor];
    const total = this.journalLines(page).length;
    const viewport = this.windowRows() - (page.failed ? 1 : 0);
    const bottom = Math.max(0, total - viewport);
    const was = this.workerCursor, wasOnRow = !this.journal && this.workerCursor >= FIRST_ACTION, shown = this.captionView();
    if (this.journal) {
      if (name === 'up' || name === 'k') {
        if (this.journalOffset > 0) this.journalOffset--;
        else this.journal = false; // back on the row of actions, on the action chosen there
      } else if (name === 'down' || name === 'j') this.journalOffset = Math.min(this.journalOffset + 1, bottom);
      else if (name === 'pageup') this.journalOffset = Math.max(0, this.journalOffset - viewport);
      else if (name === 'pagedown') this.journalOffset = Math.min(this.journalOffset + viewport, bottom);
      else if (name === 'home') this.journalOffset = 0;
      else if (name === 'escape') this.journal = false;
    } else if (name === 'up' || name === 'k') this.workerCursor = this.workerCursor > 1 ? 1 : 0;
    else if (name === 'down' || name === 'j') {
      if (this.workerCursor === 0) this.workerCursor = 1;
      else if (this.workerCursor === 1) this.workerCursor = this.actionCursor;
      else this.journal = true;
    } else if ((name === 'left' || name === 'right') && this.workerCursor >= FIRST_ACTION) {
      const actions = count - FIRST_ACTION;
      this.workerCursor = FIRST_ACTION +
        (this.workerCursor - FIRST_ACTION + (name === 'left' ? actions - 1 : 1)) % actions;
    } else if ((name === 'return' || name === 'space') && item) return this.runItem(item);
    // The caption of an action opens after the cursor has stood on it 400 ms; a key that walks
    // the row restarts the wait, an open one moves to the neighbour without it (issue 03). In a
    // row of one action ← and → leave the cursor where it is, yet they start the wait too.
    const onRow = !this.journal && this.workerCursor >= FIRST_ACTION;
    const walked = wasOnRow && (name === 'left' || name === 'right') && this.actionAt === null && !this.caption;
    // It unrolls from the moment it opens; one that moves to a neighbour starts from the lines it
    // showed, and off the row it rolls back up (issue 04).
    const now = this.now(), chosen = items[this.workerCursor];
    if (!onRow) {
      this.caption = false;
      this.actionAt = null;
      this.unroll = shown ? { item: shown.item, at: now, from: shown.lines, open: false } : null;
    } else if ((this.workerCursor !== was || onRow !== wasOnRow || walked) && chosen) {
      if (this.captionOpen()) {
        this.caption = true;
        this.unroll = { item: chosen, at: now, from: shown?.lines ?? 0, open: true };
      } else {
        this.caption = false;
        this.actionAt = now;
        this.unroll = { item: chosen, at: now + CAPTION_MS, from: 0, open: true };
      }
    }
    if (this.workerCursor >= FIRST_ACTION) this.actionCursor = this.workerCursor;
    this.changed();
  }

  // An action of the screen «Воркер»: its result goes into the journal as a step of the CLI.
  // While it runs, and after it, the caption stays closed until a key brings the cursor back.
  async runItem(item: WorkerItem): Promise<undefined> {
    this.caption = false;
    this.actionAt = null;
    this.unroll = null;
    const paused = this.page?.paused === true;
    const label = itemLabel(item, paused);
    const busy = ({
      platformAccount: t('Signing in to Google…', 'Входим в Google…'),
      chatgpt: t('Signing the worker in to ChatGPT…', 'Входим в ChatGPT для воркера…'),
      trial: t('Checking the worker…', 'Проверяем воркер…'),
      repair: t('Repairing the worker…', 'Чиним воркер…'),
      pause: paused ? t('Taking the worker off pause…', 'Снимаем воркер с паузы…') : t('Pausing the worker…', 'Ставим воркер на паузу…'),
    } satisfies Record<WorkerItem, string>)[item];
    const action = ({ platformAccount: io => this.signInPlatform(io), chatgpt: io => this.signInChatGPT(io), trial: () => this.trial(),
      repair: io => this.repair(io), pause: () => this.setPause(!paused) } satisfies
      Record<WorkerItem, (io: Io) => Promise<string>>)[item];
    // How long an action usually takes, for its bracket to fill; the sign-ins have no such time.
    const expected = ({ trial: 4_000, repair: 15_000, pause: 3_000 } as
      Partial<Record<WorkerItem, number>>)[item] ?? null;
    return this.act(busy, async note => {
      // The lines of the commands are notes while it runs: device codes, what it waits for.
      const io: Io = { print: line => note(line), prompt: async () => { throw new Error('the screen asks no questions'); },
        wait: text => { this.busy = text ?? busy; this.changed(); } };
      let text: string, tone: Step['tone'] = 'ok';
      try { text = await action(io); } catch (error) {
        const message = explain(error);
        if (message === null) throw error;
        text = message.split('\n').join(' ');
        tone = 'warn';
      }
      this.notes = [];
      this.step(`${label}: ${text}`, tone);
    }, { section: 'worker', expected });
  }

  // «Проверить сейчас»: the trial run, which reads the resets and applies nothing.
  async trial(): Promise<string> {
    const { worker, timeZone } = this;
    return trialLine(await worker.ask('trial') as unknown as Trial, timeZone).line;
  }

  // «Починить»; the screen goes on with the worker that answers to the new secret.
  async repair(io: Io): Promise<string> {
    const { fetch, googleKeychain, secretKeychain, open, appsScriptSource, reopen } = this.options;
    const { worker, message } = await repairWorker({ worker: this.worker, fetch, googleKeychain, secretKeychain, io, open, mac: this.mac,
      appsScriptSource, reopen, now: this.now, sleep: this.sleep });
    this.worker = worker;
    return message;
  }

  // «Пауза» / «Снять с паузы»: the schedule of the open worker goes off or comes back; the
  // sign-in and the data stay, so unpausing needs no new ChatGPT sign-in.
  async setPause(paused: boolean): Promise<string> {
    const { worker, mac } = this;
    return setWorkerPause({ worker, mac, paused });
  }

  // «Войти заново» for ChatGPT: a new worker session, as `aures login`.
  async signInChatGPT(io: Io): Promise<string> {
    const { fetch, now, sleep, timeZone, mac: { files }, options: { open, copy } } = this;
    await signInAgain(this.worker, { fetch, io, files, open, copy, now, sleep, timeZone });
    return renewed();
  }

  // «Войти заново» for Google: a new sign-in of the CLI.
  async signInPlatform(io: Io): Promise<string> {
    const { fetch, now, options: { googleKeychain, open } } = this;
    const before = await readSecret(googleKeychain);
    const was = (await this.mac.files.readInstall())?.accounts?.google;
    await connectGoogle({ fetch, keychain: googleKeychain, io, open, now, files: this.mac.files, fresh: true });
    const email = (await this.mac.files.readInstall())?.accounts?.google;
    // Google revokes the whole grant of the account, not one token: in the same account that
    // would end the new sign-in too. Only the grant of another account is ended, as uninstall
    // ends the last one; with an account unknown the one before is left alone.
    if (before && was && email && was !== email) await revokeGoogle(fetch, before).catch(() => {});
    return email ? t(`Signed in to Google as ${email}.`, `Вы вошли в Google как ${email}.`) : t('Signed in to Google.', 'Вы вошли в Google.');
  }

  // Runs an action, shows what it says and reads the overview again. section is where it shows
  // how far it is, expected how long it usually takes (issue 04); how it ended lights the section.
  async act(label: string, action: (note: Note) => Promise<void>,
    { section = null, expected = null }: { section?: Section | null; expected?: number | null } = {}): Promise<undefined> {
    this.busy = label;
    this.running = { at: this.now(), section, expected };
    this.said = undefined;
    this.changed();
    const note: Note = (text, tone) => {
      this.notes.push(...text.split('\n').map(line => ({ text: line, tone })));
      this.said = tone ?? 'ok';
      this.changed();
    };
    const tell = (error: unknown) => {
      const message = explain(error);
      if (message === null) throw error;
      note(message, 'warn');
    };
    try {
      try { await action(note); } catch (error) { tell(error); }
      try { await (this.view === 'worker' ? this.loadWorker() : this.load()); } catch (error) { tell(error); }
    } finally {
      this.busy = null;
      this.running = null;
      if (section) this.outcome = { at: this.now(), section, ok: this.said !== 'warn' && this.said !== 'bad' };
      this.changed();
    }
  }

  async apply(creditId: string, note: Note): Promise<void> {
    const { worker, now, sleep } = this;
    const { before } = await readyToApply(worker);
    // The spinner line says what the run waits for; the reset stays named in it.
    const wait = (text: string | null) => { if (text) { this.busy = `${resetName(creditId)}: ${text}`; this.changed(); } };
    const { code, message } = await applyReset({ worker, creditId, before, now, sleep, wait });
    note(message, code === 0 ? 'ok' : 'warn');
  }

  // Switches one rule in the rules as they are now, not as the screen last read them.
  async switchRule(rule: Rule, note: Note): Promise<void> {
    const { worker } = this;
    const stored = await storedRules(worker), { current, broken } = stored;
    if (!current) {
      throw new CommandFailed(broken ? t(`The rules do not read (${broken}). Choose them again: \`aures rules\`.`,
        `Правила не читаются (${broken}). Выберите их заново: \`aures rules\`.`) :
        t('The rules are not set. Choose them: `aures rules`.', 'Правила не заданы. Выберите их: `aures rules`.'));
    }
    const chosen = { formatVersion: RULES_FORMAT_VERSION, beforeExpiry: current.beforeExpiry, weeklyAutoApply: current.weeklyAutoApply,
      [rule]: !current[rule] };
    await saveRules({ stored, chosen, io: { print: line => note(line) } });
  }

  // The other language at once; it is kept for the next start, if this Mac lets it be written.
  async switchLanguage(): Promise<undefined> {
    setLanguage(language() === 'en' ? 'ru' : 'en');
    this.changed();
    await this.mac.files.writeLanguage(language()).catch(() => {});
  }
}

// The screen of an installed worker, read once. Before the screen opens the user may be asked
// where the worker runs.
// The bundle is the one setup and upgrade deploy, for «Починить»; null or left out without a build.
export type ScreenCommandOptions = OpenWorkerOptions & { appsScriptSource?: string | null };
export async function openScreen(options: ScreenCommandOptions): Promise<Screen> {
  const { fetch, mac, googleKeychain, secretKeychain, open, copy, appsScriptSource = null, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone } = options;
  // Its doPost failures are told on the screen, where the user repeats the action.
  const reopen = () => openWorker(options, null);
  const worker = await reopen();
  const screen = new Screen({ worker, mac, fetch, now, sleep, timeZone, googleKeychain, secretKeychain, open, copy, appsScriptSource,
    reopen });
  await screen.load();
  return screen;
}

// What of a frame taller than the terminal is shown (issue 33): the header on top and the foot
// below stay, and the part between them moves with the cursor, the selected line always in
// view — with the cursor on the first item the top shows, on the last the bottom (the journal of
// the screen «Воркер»). Where lines are hidden a mark says how many. lines are the painted
// lines of the frame, each one row; selected is the line the cursor stands on, by its index —
// the Screen finds it as it draws, through the last line that goes with it (an open caption),
// kept in view too when the room allows; offset is where the middle started the last time. head
// is how many lines on top stay: the header, and on the screen the rule under it.
export function viewport(lines: string[], { rows, foot, offset, edge, selected, through = selected, head = 1 }: { rows: number;
  foot: number; offset: number; edge: 'first' | 'last' | null; selected: number; through?: number; head?: number }):
  { lines: string[]; offset: number } {
  const middle = lines.slice(head, lines.length - foot), space = rows - head - foot, room = space - 2;
  if (lines.length <= rows) return { lines, offset: 0 };
  // Too low to keep the rule as well: only the header stays.
  if (room < 1) return head > 1 ? viewport(lines, { rows, foot, offset, edge, selected, through, head: head - 1 }) : { lines, offset: 0 };
  const pick = selected - head;
  let start = edge === 'first' ? 0 : edge === 'last' ? middle.length - room : offset;
  if (pick >= 0 && pick < middle.length) start = Math.min(Math.max(start, Math.max(pick, through - head) - room + 1), pick);
  start = Math.max(0, Math.min(start, middle.length - room));
  // A mark takes a row only where lines are hidden, so at its top the frame stands where it
  // stands whole and nothing under the header moves; a bottom with no mark shows a line more.
  if (start > 0 && start + space - 1 >= middle.length) start = middle.length - (space - 1);
  const shown = space - (start > 0 ? 1 : 0), bottom = start + shown < middle.length, count = shown - (bottom ? 1 : 0);
  // Blank lines are no lines a user misses.
  const hidden = (part: string[]) => part.filter(line => line.trim()).length;
  const above = hidden(middle.slice(0, start)), below = hidden(middle.slice(start + count));
  const mark = (arrow: string, n: number) => n ? paint([[t(`${arrow} ${n} more`, `${arrow} ещё ${n}`), S.dim]], true) : '';
  return { lines: [...lines.slice(0, head), ...start > 0 ? [mark('↑', above)] : [], ...middle.slice(start, start + count),
    ...bottom ? [mark('↓', below)] : [], ...lines.slice(lines.length - foot)], offset: start };
}

// Rows of the terminal a painted line takes: a line longer than the terminal wraps.
const rowsOf = (line: string, columns: number): number => Math.max(1, Math.ceil([...line.replace(/\x1b\[[0-9;]*m/g, '')].length / columns));

// Shows the screen in the terminal until q, on the alternate screen with a margin around it.
// A frame redraws only the lines that changed, each at its own row, and never takes more rows
// than the terminal has: a taller one would scroll it on every turn of the spinner, and the
// user's selection with it. Resolves to the exit code: 130 when Ctrl-C left an action
// unfinished; what it was doing is then printed after the screen.
export interface Terminal {
  input: NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?(mode: boolean): unknown };
  output: { columns?: number; rows?: number; write(text: string): unknown;
    on?(event: 'resize', listener: () => void): unknown; off?(event: 'resize', listener: () => void): unknown };
}
type Shown = { line: string; row: number; rows: number };
// env turns the motion off: AURES_MOTION=off, or NO_COLOR as any colour (issue 04).
export function runScreen(screen: Screen, { input, output }: Terminal, env: Record<string, string | undefined> = process.env): Promise<number> {
  screen.motion = env.AURES_MOTION !== 'off' && !env.NO_COLOR;
  let done = false, shown: Shown[] = [], bottom = 1; // the lines on the terminal with their rows, the row under them
  let offset = 0; // where the middle of a frame taller than the terminal starts (issue 33)
  const draw = (full = false) => {
    if (done) return;
    const columns = output.columns || 80, width = Math.min(WIDTH, columns - 1 - MARGIN.length);
    const frame = screen.frame(width, true);
    // A frame taller than the terminal moves with the cursor; the blank line on top goes first.
    const fitted = viewport(frame, { rows: (output.rows || 24) - 1, foot: screen.footer, offset, edge: screen.edge(),
      selected: screen.selectedLine, through: screen.throughLine, head: 2 });
    offset = fitted.offset;
    const lines = ['', ...fitted.lines.map(line => MARGIN + line)];
    // A terminal too low even for that: the top gives way, the action, its codes and the keys are at the bottom.
    let height = lines.reduce((rows, line) => rows + rowsOf(line, columns), 0);
    while (height > (output.rows || 24) && lines.length > 1) height -= rowsOf(lines.shift() ?? '', columns);
    let row = 1, text = full ? '\x1b[2J' : '';
    const next = lines.map(line => {
      const at = { line, row, rows: rowsOf(line, columns) };
      row += at.rows;
      return at;
    });
    next.forEach((at, i) => {
      if (!full && shown[i]?.line === at.line && shown[i].row === at.row) return;
      for (let r = at.row; r < at.row + at.rows; r++) text += `\x1b[${r};1H\x1b[2K`;
      text += `\x1b[${at.row};1H${at.line}`;
    });
    if (!full && row < bottom) text += `\x1b[${row};1H\x1b[J`;
    shown = next;
    bottom = row;
    if (text) output.write(`\x1b[?2026h${text}\x1b[?2026l`);
  };
  const redraw = () => draw(true);
  // While something moves the frame is drawn ten times a second (issue 04); standing still, the
  // clock and the time left move every half minute.
  let ticks = 0;
  const spin = setInterval(() => {
    ticks++;
    if (screen.moving() || ticks % 300 === 0) draw();
  }, 100);
  emitKeypressEvents(input);
  const raw = input.isRaw;
  input.setRawMode?.(true);
  input.resume();
  output.write('\x1b[?1049h\x1b[?25l');
  output.on?.('resize', redraw);
  screen.changed = () => draw();
  draw();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      if (done) return;
      const unfinished = screen.busy;
      done = true;
      screen.close();
      clearInterval(spin);
      input.off('keypress', onKey);
      output.off?.('resize', redraw);
      input.setRawMode?.(raw ?? false);
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      if (unfinished) output.write(`${t('Interrupted', 'Прервано')}: ${unfinished}\n`);
      if (error) reject(error);
      else resolve(unfinished ? 130 : 0);
    };
    const onKey = (sequence: string | undefined, key: Key = {}) => {
      screen.press({ ...key, sequence, name: key.name ?? sequence }).then(result => { if (result === 'exit') finish(); }, finish);
    };
    input.on('keypress', onKey);
  });
}

// `aures`: the interactive screen. terminal is { input, output } of a TTY.
export async function screen({ terminal, io, ...options }: ScreenCommandOptions & { terminal: Terminal }): Promise<number> {
  return command('', io, async () => runScreen(await openScreen({ io, ...options }), terminal));
}
