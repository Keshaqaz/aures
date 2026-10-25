import { deviceLogin, sessionEmail } from '../chatgpt/session.ts';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET, TRIAL_INPUT } from '../worker/layout.ts';
import { generateKey, sealState, readRules, BrokenState, STATE_FORMAT_VERSION } from '../worker/state-file.ts';
import { workflowYaml } from '../worker/workflow.ts';
import { CommandFailed, WORKER_REPOSITORY, WORKER_DESCRIPTION, workingLine, connectGitHub, workerRepository,
  chooseRules, readSummary, failedRunAdvice, runWorkerNow, command, trialVerdict, notReadYet, switchUnfinished,
  Stages, stagedCode, doneLine, chatgptWhy } from './common.ts';
import { setupGoogle } from './setup-google.ts';
import { runWhileEnabled } from './pause.ts';
import type { Install, WatchFiles } from './watch-files.ts';
import { followWeeklyRule } from './mac-check.ts';
import type { CommandOptions, GitHub, Io, Sleep } from './common.ts';
import type { GitHubApi, Repository } from '../github/api.ts';
import { t } from './language.ts';

// Dispatches a trial run (CONTEXT.md, «Пробный запуск»), waits for it and reads what the
// worker published and what the rules would do. A worker on pause runs it with the schedule
// briefly on and off again after, so the pause stays (ADR-0007). The line is what the user
// reads on the screen's «Проверить сейчас»; setup ends with doneLine over resets (issue 30).
export async function trialRun({ api, repo, io, now, sleep, timeZone, paused }:
  { api: GitHubApi; repo: Repository; io: Io; now: () => number; sleep: Sleep; timeZone: string | undefined; paused: boolean }): Promise<{ line: string; resets: number | null; busy: boolean }> {
  const one = () => runWorkerNow({ api, repo, inputs: { [TRIAL_INPUT]: 'true' }, now, sleep, wait: io.wait });
  const { run, logged } = paused ? await runWhileEnabled({ platform: 'github', api, repo }, one) : await one();
  if (run.conclusion !== 'success') throw new CommandFailed(`${failedRunAdvice(logged ?? {})}\n${t('Details', 'Подробности')}: ${run.html_url}`);
  const summary = logged?.outcome === 'transient_error' ? null : await readSummary(api, repo);
  const verdict = logged && trialVerdict(logged);
  if (summary) return { line: [workingLine(summary, timeZone), verdict].filter(Boolean).join(' '), resets: summary.resets?.length ?? 0, busy: false };
  // Before its first successful read the worker publishes nothing.
  const busy = logged?.outcome === 'transient_error';
  return { line: notReadYet(busy), resets: null, busy };
}

// The platform of the worker (ADR-0007), as the install record keeps it; asked without a
// recommendation, with what each costs, when there is no record yet. The rest of the record,
// such as a pause, stays as it is.
async function choosePlatform(io: Io, files: WatchFiles): Promise<Install> {
  const install = await files.readInstall();
  if (install) return install;
  io.print(t('The worker is a small program in the cloud that applies your resets by itself. Where should it run:',
    'Воркер — небольшая программа в облаке, которая сама применяет сбросы. Где ему работать:'));
  io.print(t('  1. GitHub Actions — runs once an hour, but GitHub skips many runs.',
    '  1. GitHub Actions — раз в час, GitHub пропускает многие запуски.'));
  io.print(t('  2. Google Apps Script — runs every 5 minutes.',
    '  2. Google Apps Script — каждые 5 минут.'));
  for (;;) {
    const answer = (await io.prompt(t('Type 1 or 2: ', 'Введите 1 или 2: '))).trim();
    const platform = answer === '1' ? 'github' : answer === '2' ? 'google' : null;
    if (platform) {
      io.print('');
      const chosen: Install = { platform };
      await files.writeInstall(chosen);
      return chosen;
    }
  }
}

// `aures setup`: from nothing to a working worker, or the missing parts of an existing one,
// on the platform the user picks once. Returns the process exit code.
// workerSource is the GitHub worker bundle, appsScriptSource the Apps Script one; random picks the cron minute.
// openScreen is what a terminal setup does when it is done (issue 30): setup tells the user
// and hands over as its last step. main passes one that opens the screen after the command's
// own readline is closed — stdin must have one reader while the screen runs; tests inject
// their own to see that the hand-over comes after everything setup has to say.
export interface SetupOptions extends CommandOptions {
  workerSource: string;
  appsScriptSource: string;
  random?: () => number;
  openScreen?: () => Promise<number>;
}
export async function setup(options: SetupOptions): Promise<number> {
  const { io, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  const code = await command('setup', io, async () => {
    const install = await choosePlatform(io, mac.files);
    // setup would bring the new worker's schedule back before the old one is quenched.
    if (install.switching) throw new CommandFailed(switchUnfinished());
    const paused = install.paused === true;
    // The stages of issue 30, the platform first — chosen just now or before.
    const google = install.platform === 'google';
    const stages = new Stages(io, 5);
    stages.line(t('Platform', 'Площадка'), google ? 'Google Apps Script' : 'GitHub Actions');
    try {
      return google ?
        await setupGoogle({ ...options, now, sleep, paused, stages }) :
        await setupGitHub({ ...options, now, sleep, paused, stages });
    } finally { io.wait(null); }
  });
  // A successful setup in a terminal opens the screen (issue 30): the resets and the rules it
  // just made are what the screen shows. This is setup's last step — tell the user and hand
  // over — so that by the time the screen runs, setup itself is done. Outside a terminal, or
  // after a failure, setup ends as any other command.
  if (code !== 0 || !options.openScreen) return code;
  io.print(t('Opening aures…', 'Открываю aures…'));
  return options.openScreen();
}

// On GitHub. Files already in the repository are kept, so a repeated setup never loses state
// or rules and never rewrites the cron. This Mac follows the weekly rule: the check from it is
// set up or removed. A worker on pause stays paused: the files go in, the schedule stays off.
async function setupGitHub({ fetch, keychain, io, open, copy, workerSource, mac, now, sleep, random = Math.random, timeZone, paused, stages }:
  SetupOptions & { now: () => number; sleep: Sleep; paused: boolean; stages: Stages }): Promise<number> {
  // Stage 2: the sign-in of the CLI to GitHub, its code what the user does.
  const signIn = stages.begin(t('Signing in to GitHub', 'Вход в GitHub'),
    t('to create the private worker repository in your account', 'чтобы создать приватный репозиторий воркера в вашем аккаунте'));
  const gitHubCode = stagedCode(signIn, open, copy, now);
  let github: GitHub;
  try {
    github = await connectGitHub({ fetch, keychain, io: signIn.io, open, copy, now, sleep, onCode: gitHubCode.onCode, quiet: true });
  } finally { gitHubCode.ended(); }
  signIn.done(github.login);

  // Stage 3: the repository of the worker, and what is already in it.
  const repoStage = stages.begin(t('The worker repository', 'Репозиторий воркера'),
    t("a private repository with the worker's code, schedule and encrypted state",
      'приватный репозиторий: в нём код воркера, расписание и его зашифрованное состояние'));
  const existing = await workerRepository(github);
  const repo = existing ?? await github.api.createRepository({ name: WORKER_REPOSITORY, description: WORKER_DESCRIPTION });
  const name = repo.full_name;
  const [state, rules, worker, workflow, hasKey] = await Promise.all([
    github.api.file(name, FILES.state), github.api.file(name, FILES.rules), github.api.file(name, FILES.worker), github.api.file(name, FILES.workflow),
    github.api.hasSecret(name, STATE_KEY_SECRET)]);
  // setup keeps an existing workflow, and one of an older version has no trial run to dispatch.
  if (workflow && !workflow.text.includes(`\n      ${TRIAL_INPUT}:\n`)) {
    throw new CommandFailed(t('The worker is of an older version. Run `aures upgrade`, then `aures setup` again.',
      'Воркер старой версии. Запустите `aures upgrade`, затем снова `aures setup`.'));
  }
  repoStage.done(existing ? t(`${name} already there`, `${name} уже есть`) : t(`${name} created`, `${name} создан`));

  // Stage 4: the worker's own session of ChatGPT.
  const chatgpt = stages.begin(t('Signing in to ChatGPT', 'Вход в ChatGPT'), chatgptWhy());
  // The key cannot be read back, so a state without its key is useless and is replaced.
  if (state && hasKey) chatgpt.done(t('already there', 'уже есть'));
  else {
    const code = stagedCode(chatgpt, open, copy, now);
    let session;
    try { session = await deviceLogin({ fetch, now, sleep, onCode: code.onCode }); } finally { code.ended(); }
    const key = generateKey();
    // A login left over from an interrupted `login` must not replace this new session.
    await github.api.deleteSecret(name, LOGIN_SECRET);
    // The key comes first: a state that reaches the repository is always openable.
    await github.api.putSecret(name, STATE_KEY_SECRET, key);
    await github.api.putFile(name, FILES.state, sealState({ formatVersion: STATE_FORMAT_VERSION, session, pending: null, applied: [] }, key),
      { message: 'Save the worker session', sha: state?.sha });
    const email = sessionEmail(session);
    await mac.files.rememberAccount('chatgpt', email);
    chatgpt.done(email ?? t('signed in', 'вход выполнен'));
  }

  // Stage 5: the first run — the rules, the files, the schedule and the trial run.
  const first = stages.begin(t('First run', 'Первый запуск'),
    t('the rules, the schedule once an hour and a trial run that spends nothing',
      'правила, расписание раз в час и пробный запуск, который ничего не тратит'));
  let weekly: boolean | null = null;
  if (!rules) {
    // The question needs the line: the spinner waits for after it.
    first.io.wait(null);
    const chosen = await chooseRules(first.io);
    await github.api.putFile(name, FILES.rules, `${JSON.stringify(chosen, null, 2)}\n`, { message: 'Set the general rules' });
    first.step(t('the rules are saved', 'правила сохранены'));
    weekly = chosen.weeklyAutoApply;
  } else {
    // Rules that do not read leave this Mac as it is; the trial run names the fix.
    try { weekly = readRules(rules.text).weeklyAutoApply; } catch (error) { if (!(error instanceof BrokenState)) throw error; }
  }
  if (!worker) await github.api.putFile(name, FILES.worker, workerSource, { message: 'Add the worker' });
  // The workflow goes last, so its schedule never meets a half-filled repository.
  if (!workflow) {
    const minute = 1 + Math.floor(random() * 59);
    await github.api.putFile(name, FILES.workflow, workflowYaml({ minute }), { message: 'Run the worker every hour' });
  }
  first.step(worker && workflow ? t("the worker's files are already in place", 'файлы воркера уже на месте') :
    t("the worker's files and the hourly schedule", 'файлы воркера и расписание раз в час'));
  if (weekly !== null) await followWeeklyRule({ weekly, mac, fetch, io: first.io, open, copy, now, sleep });
  const trial = await trialRun({ api: github.api, repo, io: first.io, now, sleep, timeZone, paused });
  first.done(t('the trial run passed', 'пробный запуск прошёл'));
  io.print('');
  io.print(doneLine(trial.resets, { busy: trial.busy, platform: 'github', paused }));
  return 0;
}
