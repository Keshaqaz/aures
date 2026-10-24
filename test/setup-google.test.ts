import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/cli/setup.ts';
import { credit } from './support/fake-world.ts';
import { cliWorld } from './support/cli-world.ts';
import type { CliWorld, RunOptions } from './support/cli-world.ts';
import { USER_SETTINGS } from './support/fake-google.ts';
import type { FakeProject } from './support/fake-google.ts';

const HOUR = 3600_000, DAY = 24 * HOUR;
const GOOGLE_LOGIN = 'https://accounts.google.com/';
// The device-code page the ChatGPT sign-in opens (issue 23).
const DEVICE = 'https://auth.openai.com/codex/device';

async function googleWorld() {
  const cli = await cliWorld();
  // On Google the rules are set without a question (issue 24), so the platform is the only answer.
  return { ...cli, run: ({ answers = ['2'], ...rest }: RunOptions = {}) => cli.run(setup, { answers, ...rest }) };
}
const deployed = ({ world }: Pick<CliWorld, 'world'>): FakeProject => {
  const project = world.google.project();
  assert.ok(project);
  return project;
};
const property = (project: FakeProject, key: string): unknown => JSON.parse(project.gas?.properties.get(key) ?? 'null');
const noViolations = ({ world }: Pick<CliWorld, 'world'>) => {
  assert.deepEqual(world.google.violations, []);
  assert.deepEqual(world.violations, []);
};

test('setup on Google goes from nothing to a scheduled worker and ends with a trial run that spends nothing', async () => {
  const cli = await googleWorld();
  const { world, mac } = cli;
  world.chatgpt.credits.push(credit('RateLimitResetCredit_0eb466b3212c819193799a1741f067f8', world.now + 30 * 60_000));
  const { code, io } = await cli.run();
  assert.equal(code, 0, io.output());

  // Both platforms are named, shortly (issue 30), none is recommended.
  assert.match(io.output(), /1\. GitHub Actions — раз в час, GitHub пропускает многие запуски\./);
  assert.match(io.output(), /2\. Google Apps Script — каждые 5 минут\./);
  assert.doesNotMatch(io.output(), /рекоменд/i);
  // The stages of issue 30: one line per stage, the platform first, ✓ with what the stage
  // got; the one switch of the Apps Script API is told at once, inside the worker's stage.
  assert.deepEqual(io.lines.filter(line => /^\[\d\/4\]/.test(line)), [
    '[1/4] Площадка: 2. Google Apps Script',
    '[2/4] Вход в Google… ✓ owner@example.invalid',
    '[3/4] Воркер в Google… ✓',
    '[4/4] Вход в ChatGPT: код FAKE-1000 (скопирован) ✓',
  ], io.output());
  assert.match(io.output(), /Включите API скрипта Google Apps: .*«API скрипта приложений Google Apps» и нажмите переключатель\. aures продолжит сам\./);
  // Short (issue 30): from the menu to «Готово» — the menu, the stages and the API switch.
  const done = io.lines.findIndex(line => line.startsWith('Готово.'));
  assert.ok(done > 0 && done <= 8, io.output());
  assert.equal(io.lines.at(-1), 'Готово. Сбросов: 3.');
  // A quick user sees no buttons and no addresses (issue 30): those wait for a slow one.
  assert.doesNotMatch(io.output(),
    /Если браузер не открылся|«Продолжить»|Review permissions|Разрешите скрипту|два предупреждения|Правила: /);
  // The rules go in without a question (issue 24): the platform is the only prompt, the worker
  // gets both rules on.
  assert.deepEqual(io.asked, ['Введите 1 или 2: ']);
  assert.doesNotMatch(io.output(), /Когда применять сбросы/);

  const project = deployed(cli);
  assert.equal(world.google.projects.size, 1);
  const [deploymentId] = [...project.deployments.keys()];
  const url = `https://script.google.com/macros/s/${deploymentId}/exec`;
  assert.deepEqual(world.google.opened.filter(href => !href.startsWith(GOOGLE_LOGIN)), [USER_SETTINGS, url, DEVICE]);
  assert.deepEqual(project.granted, ['scriptapp', 'external_request']);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.deepEqual(property(project, 'rules'), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true });
  const state = property(project, 'state') as { session: { accountId: string; refreshToken: string } };
  assert.equal(state.session.accountId, world.accountId);
  assert.equal(state.session.refreshToken, world.auth.current?.refresh);
  assert.deepEqual((property(project, 'journal') as { kind: string }[]).map(entry => entry.kind), ['login', 'trial']);
  assert.deepEqual(world.consumeCalls(), []);

  assert.deepEqual(await mac.files.readInstall(), { platform: 'google', google: { scriptId: project.scriptId, deploymentId, url },
    accounts: { google: 'owner@example.invalid', chatgpt: 'fake@example.invalid' } });
  assert.equal(world.google.deployedSecret(), await cli.secretKeychain.read());
  assert.equal(world.github.requests.length, 0, 'GitHub is not touched');
  assert.equal(mac.launchctl.calls.length, 0, 'the weekly rule needs no check from this Mac on Google');
  noViolations(cli);
});

test('a repeated setup on Google finds the project and keeps its state, rules and schedule, without new sign-ins', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  await cli.run({ answers: ['2'] });
  const project = deployed(cli);
  const before = new Map(project.gas?.properties);
  const versions = project.versions.length;
  const requests = world.google.requests.length;
  world.advance(DAY);

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.deepEqual(io.asked, [], 'neither the platform nor the rules are asked again');
  assert.doesNotMatch(io.output(), /Изменить: `aures rules`/, 'the rules line is not printed again');
  assert.equal(world.google.projects.size, 1);
  assert.equal(project.versions.length, versions, 'nothing is deployed again');
  assert.equal(world.google.requests.slice(requests).filter(r => !r.url.includes('/macros/')).length, 0, 'no Google sign-in or API call');
  assert.doesNotMatch(io.output(), /auth\.openai\.com|не проверял/);
  // The worker's session is there: the stage is done at once (issue 30).
  assert.match(io.output(), /\[4\/4\] Вход в ChatGPT… ✓ уже есть/);
  assert.equal(project.gas?.properties.get('rules'), before.get('rules'));
  const state = property(project, 'state') as { session: { refreshToken: string } };
  assert.equal(state.session.refreshToken, world.auth.sessions[0]?.refresh);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.equal(io.lines.at(-1), 'Готово. Сбросов: 2.');
  noViolations(cli);
});

test('setup stopped while the script waits to be allowed goes on with the consent in the same project', async () => {
  const cli = await googleWorld();
  const { world, googleKeychain } = cli;
  world.google.apiEnabled = true;
  world.google.scriptConsent = 'closed';
  // The user gives up waiting: Ctrl-C after a few polls.
  let polls = 0;
  const interrupted = cli.run({ sleep: async ms => { if (++polls > 3) throw new Error('Ctrl-C'); world.advance(ms); } });
  await assert.rejects(interrupted, /Ctrl-C/);
  const project = deployed(cli);
  assert.equal(project.granted, null);
  const token = await googleKeychain.read();

  world.google.scriptConsent = ['scriptapp', 'external_request'];
  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.equal(world.google.projects.size, 1);
  assert.equal(project.versions.length, 1, 'the deployed version is kept');
  assert.equal(world.google.opened.filter(href => href.startsWith(GOOGLE_LOGIN)).length, 1, 'one Google sign-in');
  assert.equal(await googleKeychain.read(), token);
  assert.match(io.output(), /\[3\/4\] Воркер в Google… ✓/);
  // A quick consent sees no buttons and no page address (issue 30); the reopen itself is the tell.
  assert.doesNotMatch(io.output(), /Разрешите скрипту|Review permissions/);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.match(io.lines.at(-1) ?? '', /^Готово\./);
  noViolations(cli);
});

// The user ticks every box at the consent the web app opens the second time: setup wraps
// google.open, which grants what scriptConsent names at each visit of the web app URL.
const fullConsentOnReopen = (cli: Pick<CliWorld, 'world'>): void => {
  const open = cli.world.google.open;
  let visits = 0;
  cli.world.google.open = async href => {
    if (/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(href) && ++visits > 1) {
      cli.world.google.scriptConsent = ['scriptapp', 'external_request'];
    }
    return open(href);
  };
};

// A consent without the triggers box (issue 29): the worker answers 'scopes', setup tells what
// happened, opens the consent again, and with every box ticked goes to the end.
test('a script consented without its triggers box makes setup reopen the consent and go on', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  world.google.scriptConsent = ['external_request'];
  fullConsentOnReopen(cli);
  const { code, io } = await cli.run();
  assert.equal(code, 0, io.output());
  // The consent is first given after the deploy and then again, when the login answers 'scopes';
  // to a quick user both passes are silent (issue 30), the reopened page is the tell.
  assert.doesNotMatch(io.output(), /Согласие|Разрешите скрипту/);
  assert.equal(world.google.opened.filter(href => /\/macros\/s\/[^/]+\/exec$/.test(href)).length, 2);
  const project = deployed(cli);
  assert.deepEqual(project.granted, ['scriptapp', 'external_request']);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.match(io.lines.at(-1) ?? '', /^Готово\./);
  noViolations(cli);
});

// A consent without the external services box (issue 29): the status already says so — the
// authorization check needs no request — and setup reopens the consent before going on.
test('a script consented without its external services box makes login reopen the consent and go on', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  world.google.scriptConsent = ['scriptapp'];
  fullConsentOnReopen(cli);
  const { code, io } = await cli.run();
  assert.equal(code, 0, io.output());
  // The consent is first given after the deploy and then again, when the login answers 'scopes'.
  assert.equal(world.google.opened.filter(href => /\/macros\/s\/[^/]+\/exec$/.test(href)).length, 2);
  const project = deployed(cli);
  assert.deepEqual(project.granted, ['scriptapp', 'external_request']);
  // The login that met the partial consent wrote no journal entry; the one after it did.
  assert.deepEqual((property(project, 'journal') as { kind: string }[]).map(entry => entry.kind), ['login', 'trial']);
  assert.match(io.lines.at(-1) ?? '', /^Готово\./);
  noViolations(cli);
});

// A partial consent the user gave up on (issue 29): a repeated setup recognizes the missing
// scopes at once, reopens the consent and, with every box ticked, goes to the end.
test('a repeated setup reopens the consent of a script left with partial scopes', async () => {
  const cli = await googleWorld();
  const { world, googleKeychain } = cli;
  world.google.apiEnabled = true;
  world.google.scriptConsent = ['external_request'];
  // The user never ticks the second box: Ctrl-C while setup waits after reopening the consent.
  let polls = 0;
  const interrupted = cli.run({ sleep: async ms => { if (++polls > 3) throw new Error('Ctrl-C'); world.advance(ms); } });
  await assert.rejects(interrupted, /Ctrl-C/);
  const project = deployed(cli);
  assert.deepEqual(project.granted, ['external_request']);
  const opened = world.google.opened.length;

  world.google.scriptConsent = ['scriptapp', 'external_request'];
  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  // The deploy is kept; the missing scopes take setup straight to the consent again.
  assert.equal(project.versions.length, 1, 'nothing is deployed again');
  assert.equal(world.google.opened.slice(opened).filter(href => /\/macros\/s\/[^/]+\/exec$/.test(href)).length, 1);
  assert.deepEqual(project.granted, ['scriptapp', 'external_request']);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.match(io.lines.at(-1) ?? '', /^Готово\./);
  noViolations(cli);
});

// The review of issue 29: a user who never ticks the external services box. Setup waits at the
// consent, tells why, and reopens the page at most once a minute — never a cycle of tabs; the
// wait ends only with the user (Ctrl-C here).
test('a consent left without a box is waited for with the hint, reopening the page no more than once a minute', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  world.google.apiEnabled = true;
  world.google.scriptConsent = ['scriptapp'];
  let polls = 0;
  const interrupted = cli.run({ sleep: async ms => { if (++polls > 40) throw new Error('Ctrl-C'); world.advance(ms); } });
  await assert.rejects(interrupted, /Ctrl-C/);
  const project = deployed(cli);
  assert.deepEqual(project.granted, ['scriptapp']);
  // ~40 polls of 5 s: the first opening, the reopening on the first incomplete answer, then once a minute.
  const pages = world.google.opened.filter(href => /\/macros\/s\/[^/]+\/exec$/.test(href)).length;
  assert.ok(pages >= 2 && pages <= 5, `the consent page opened ${pages} times`);
  assert.equal(project.gas?.triggers.length ?? 0, 0, 'nothing is scheduled without every scope');
});

// The review of issue 29: a repeated setup over a consent left without the external services box
// sees it at the status and reopens the consent, instead of meeting it only at the login.
test('a repeated setup reopens the consent of a script left without its external services box', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  world.google.apiEnabled = true;
  world.google.scriptConsent = ['scriptapp'];
  let polls = 0;
  const interrupted = cli.run({ sleep: async ms => { if (++polls > 3) throw new Error('Ctrl-C'); world.advance(ms); } });
  await assert.rejects(interrupted, /Ctrl-C/);
  const project = deployed(cli);
  assert.deepEqual(project.granted, ['scriptapp']);
  const opened = world.google.opened.length;

  world.google.scriptConsent = ['scriptapp', 'external_request'];
  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.equal(project.versions.length, 1, 'nothing is deployed again');
  assert.equal(world.google.opened.slice(opened).filter(href => /\/macros\/s\/[^/]+\/exec$/.test(href)).length, 1);
  assert.deepEqual(project.granted, ['scriptapp', 'external_request']);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.match(io.lines.at(-1) ?? '', /^Готово\./);
  noViolations(cli);
});

test('setup interrupted right after the project is created deploys into that project', async () => {
  const cli = await googleWorld();
  const { world, mac } = cli;
  world.google.apiEnabled = true;
  world.google.failNext = 'update_content';
  const first = await cli.run();
  assert.equal(first.code, 1);
  assert.match(first.io.lines.at(-1) ?? '', /Ошибка Google \(update_content_500\)\. Повторите `aures setup`: сделанное сохранится/);
  const project = deployed(cli);
  assert.deepEqual(await mac.files.readInstall(), { platform: 'google', google: { scriptId: project.scriptId },
    accounts: { google: 'owner@example.invalid' } });

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.equal(world.google.projects.size, 1);
  assert.equal(project.deployments.size, 1);
  noViolations(cli);
});

test('a worker that does not know the secret in the Keychain is deployed again under the same URL', async () => {
  const cli = await googleWorld();
  const { world, secretKeychain, mac } = cli;
  await cli.run();
  const install = await mac.files.readInstall();
  const old = await secretKeychain.read();
  await secretKeychain.write('another-secret');

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.deepEqual(await mac.files.readInstall(), install);
  const fresh = await secretKeychain.read();
  assert.notEqual(fresh, old);
  assert.equal(world.google.deployedSecret(), fresh);
  assert.equal(deployed(cli).versions.length, 2);
  assert.match(io.output(), /\[4\/4\] Вход в ChatGPT… ✓ уже есть/);
  noViolations(cli);
});

// A redeployed web app keeps answering with the previous version, which does not know the new
// secret, until Google serves the new one; the setup waits that out (issue 20).
test('a web app still serving the previous version after a redeploy is waited out', async () => {
  const cli = await googleWorld();
  const { world, secretKeychain } = cli;
  await cli.run();
  await secretKeychain.write('another-secret');
  world.google.servePrevious = 2;

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.ok(io.waits.includes('Ждём, когда Google начнёт отдавать новую версию воркера…'), io.output());
  assert.equal(world.google.deployedSecret(), await secretKeychain.read());
  assert.equal(deployed(cli).versions.length, 2);
  assert.equal(io.lines.at(-1), 'Готово. Сбросов: 2.');
  noViolations(cli);
});

test('a web app that keeps answering with the previous version past the minute is a clear failure', async () => {
  const cli = await googleWorld();
  const { world, secretKeychain } = cli;
  await cli.run();
  await secretKeychain.write('another-secret');
  world.google.servePrevious = 1000;

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 1);
  assert.equal(io.lines.at(-1), 'Web app воркера всё ещё отвечает прежней версией: новая не вступила в силу за минуту. ' +
    'Повторите `aures setup` через несколько минут.');
  assert.ok(io.waits.includes('Ждём, когда Google начнёт отдавать новую версию воркера…'), io.output());
  assert.equal(io.waits.at(-1), null, 'the wait line is taken away');
  noViolations(cli);
});

test('the platform asked again until the answer is 1 or 2, and GitHub keeps its own path', async () => {
  const cli = await googleWorld();
  const { code, io } = await cli.run({ answers: ['3', '', '1', ''] });
  assert.equal(code, 0, io.output());
  assert.equal(io.asked.filter(question => question === 'Введите 1 или 2: ').length, 3);
  assert.deepEqual(await cli.mac.files.readInstall(), { platform: 'github', accounts: { chatgpt: 'fake@example.invalid' } });
  assert.ok(cli.world.github.repo());
  assert.equal(cli.world.google.requests.length, 0);
  assert.match(io.output(), /Перед истечением \(в последние 8 часов\)/);
});

// ─── The deferred hints of issue 30 ────────────────────────────────────────────

// A user slow at Google's own screens: after ~30 s of the world's clock one line appears,
// with the buttons as a chain and the address for a browser that did not open (issue 30).
// The user of this test spends 35 s on the screens while the page is still open; the hint's
// wait is measured by the injected now, so the line comes from that time and not before — a
// quick user (the test above) sees none of it.
test('a slow user at the Google screens gets the buttons and the address as one line', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  const open = world.google.open;
  world.google.open = async (href: string) => {
    if (href.startsWith(GOOGLE_LOGIN)) {
      world.advance(35_000);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return open(href);
  };
  const { code, io } = await cli.run();
  assert.equal(code, 0, io.output());
  const hints = io.lines.filter(line => line.startsWith('Вход в Google: «Продолжить»'));
  assert.equal(hints.length, 1, io.output());
  assert.match(hints[0] ?? '', /Вход в Google: «Продолжить» → «Продолжить» → отметьте все галочки → «Продолжить»\. Если браузер не открылся: https:\/\/accounts\.google\.com\//);
  noViolations(cli);
});

// A user slow at the script's consent: the same one line, with the page's address (issue 30).
test('a slow user at the consent gets its buttons as one line', async () => {
  const cli = await googleWorld();
  cli.world.google.consentAfterMs = 45_000;
  const { code, io } = await cli.run();
  assert.equal(code, 0, io.output());
  const hints = io.lines.filter(line => line.startsWith('Разрешите скрипту работать:'));
  assert.equal(hints.length, 1, io.output());
  assert.match(hints[0] ?? '', /«Review permissions» → тот же аккаунт → «Дополнительные настройки» → «Перейти на страницу "aures-worker" \(небезопасно\)» → обе галочки → «Продолжить»\. Страница: https:\/\/script\.google\.com\/macros\/s\/.*\/exec/);
  noViolations(cli);
});

// The consent of issue 29, reopened for a box the user left unticked, tells a slow user what
// it wants — the same deferred one line.
test('a consent reopened for a missing box tells it to a slow user as one line', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  world.google.scriptConsent = ['external_request'];
  world.google.consentAfterMs = 45_000;
  fullConsentOnReopen(cli);
  const { code, io } = await cli.run();
  assert.equal(code, 0, io.output());
  // The first wait names the page, the reopened one the boxes it wants (issue 29).
  assert.equal(io.lines.filter(line => line.startsWith('Разрешите скрипту работать:')).length, 1, io.output());
  const reopened = io.lines.filter(line => line.startsWith('Согласие дало не все доступы:'));
  assert.equal(reopened.length, 1, io.output());
  assert.match(reopened[0] ?? '', /Согласие дало не все доступы: отметьте обе галочки \(или «Выбрать все»\) → «Продолжить»\. Страница: https:\/\/script\.google\.com\/macros\/s\/.*\/exec/);
  noViolations(cli);
});

// A user slow to enter the ChatGPT code: the code is in the stage line from the first moment,
// and the page's address comes as one line after ~30 s of the world's clock (issue 30). The
// user of this test enters the code only after 35 s; each poll of the login takes a real
// moment, as a real one takes real time, so the CLI's clock sees the wait grow.
test('a slow user at the ChatGPT code gets the address as one line', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  const lines: string[] = [], asked: string[] = [];
  const seen: { code: string | null, at: number } = { code: null, at: 0 };
  let approved = false;
  const io = {
    print: (line: string) => { lines.push(line); },
    wait: (text: string | null) => {
      const code = /FAKE-\d+/.exec(String(text));
      if (code && seen.code === null) { seen.code = code[0]; seen.at = world.now; }
    },
    prompt: async (question: string) => { asked.push(question); lines.push(question); return '2'; },
  };
  const sleep = async (ms: number) => {
    world.advance(ms);
    await new Promise(resolve => setTimeout(resolve, 50));
    if (!approved && seen.code !== null && world.now - seen.at >= 45_000) {
      approved = true;
      world.approve(seen.code);
    }
  };
  const { code } = await cli.run({ io, sleep });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(approved, 'the user did enter the code in the end');
  const hints = lines.filter(line => line.includes('Если браузер не открылся: https://auth.openai.com/codex/device'));
  assert.equal(hints.length, 1, lines.join('\n'));
  assert.match(lines.find(line => line.startsWith('[4/4]')) ?? '', /Вход в ChatGPT: код FAKE-\d+ \(скопирован\) ✓/);
  assert.deepEqual(asked, ['Введите 1 или 2: ']);
});
