import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/cli/setup.ts';
import { status } from '../src/cli/status.ts';
import { applyNow } from '../src/cli/apply-now.ts';
import { rules } from '../src/cli/rules.ts';
import { login } from '../src/cli/login.ts';
import { openScreen } from '../src/cli/screen.ts';
import type { Screen } from '../src/cli/screen.ts';
import { credit } from './support/fake-world.ts';
import { cliWorld } from './support/cli-world.ts';
import { SCRIPT_HOME } from './support/fake-google.ts';
import type { FakeProject } from './support/fake-google.ts';
import { KeychainUnavailable } from '../src/cli/keychain.ts';
import type { Keychain } from '../src/cli/keychain.ts';
import { workerDid } from '../src/cli/google.ts';

const HOUR = 3600_000, MINUTE = 60_000;
const GOOGLE_LOGIN = 'https://accounts.google.com/';
// A Keychain that does not answer, as a locked one.
const lockedKeychain = (): Keychain => ({
  read: async () => { throw new KeychainUnavailable(); },
  write: async () => {},
  remove: async () => {},
});

// A worker installed on Google by setup with the default rules (both on, issue 24): resets
// reset-a (in 5 days) and reset-b (in 2 days 3 hours).
async function installed() {
  const env = await cliWorld();
  const { code, io } = await env.run(setup);
  assert.equal(code, 0, io.output());
  const project = env.world.google.project();
  assert.ok(project?.gas);
  const gas = project.gas;
  const property = (key: string): unknown => JSON.parse(gas.properties.get(key) ?? 'null');
  const state = () => property('state') as { session: { refreshToken: string; accountId: string } };
  const journal = () => (property('journal') as { kind: string; outcome: string }[]);
  // Only the web app is asked: no Google sign-in, no Apps Script API.
  const requests = env.world.google.requests.length;
  const onlyWebApp = () => {
    assert.deepEqual(env.world.google.requests.slice(requests).filter(r => !r.url.includes('/macros/')), []);
    assert.deepEqual(env.world.google.violations, []);
  };
  return { ...env, project, gas, property, state, journal, onlyWebApp };
}
const link = (project: FakeProject): string => `https://script.google.com/home/projects/${project.scriptId}`;

test('status on Google shows the resets, the rules with the one-hour window and the worker by its journal', async () => {
  const { world, gas, project, run, onlyWebApp } = await installed();
  world.chatgpt.credits.push(credit('reset-c', world.now + 3 * HOUR));
  world.advance(HOUR);
  gas.tick();
  world.advance(2 * MINUTE);

  const { code, io } = await run(status);
  assert.equal(code, 0, io.output());
  assert.ok(/СБРОСЫ · 3/.test(io.output()), io.output());
  assert.match(io.output(), /\n│ reset-c {3}через 1 ч +20 окт 15:00\n/, 'outside the window of an hour it is not «applies soon»');
  assert.ok(io.lines.includes('│ ☑ Перед истечением (в последний час)'));
  assert.ok(/● активен\n│ следующий запуск ожидается через 3 мин/.test(io.output()), io.output());
  assert.ok(io.lines.includes(`│ ${link(project)}`), io.output());
  onlyWebApp();
});

test('a lost worker session on Google shows in status at once, and login brings the worker back', async () => {
  const { world, gas, project, run, state, journal, onlyWebApp } = await installed();
  world.endSession('refresh_token_invalidated');
  world.advance(HOUR);
  // The failed trigger run is what Google mails the user about.
  assert.throws(() => gas.tick(), /aures login/);

  let { code, io } = await run(status);
  assert.equal(code, 0);
  assert.ok(/● ошибка запуска\n│ последний запуск с ошибкой · 20 окт 13:00/.test(io.output()), io.output());
  assert.equal(io.lines.at(-1), '! Воркер потерял вход в ChatGPT. Войдите заново: `aures login`. ' +
    `Подробности: ${link(project)}/executions`);

  ({ code, io } = await run(login));
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /Вход обновлён, правила и история на месте\.\nВоркер работает\. Сбросов: 2/);
  assert.equal(state().session.refreshToken, world.auth.current?.refresh);
  assert.equal(journal().at(-1)?.kind, 'login');
  world.advance(5 * MINUTE);
  gas.tick();
  assert.equal(journal().at(-1)?.outcome, 'idle');
  onlyWebApp();
});

test('login on Google into another ChatGPT account is rejected and keeps the session', async () => {
  const { world, run, state } = await installed();
  const before = state().session;
  world.accountId = 'account-other';
  const { code, io } = await run(login);
  assert.equal(code, 1);
  assert.match(io.lines.at(-1) ?? '', /^Это другой аккаунт ChatGPT.*`aures uninstall`/);
  assert.deepEqual(state().session, before);
});

test('apply-now on Google applies the chosen reset in doPost and shows the result', async () => {
  const { world, run, journal, onlyWebApp } = await installed();
  const { code, io } = await run(applyNow, { answers: ['1', 'y'] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /1\. reset-b — истекает/);
  assert.equal(io.lines.at(-1), 'Сброс reset-b применён.');
  assert.equal(world.consumeCalls().length, 1);
  assert.deepEqual(journal().at(-1), { ...journal().at(-1), kind: 'apply_now', outcome: 'applied' });
  assert.ok(io.waits.includes(null), 'the wait line goes away');
  onlyWebApp();
});

test('apply-now on Google with a lost worker session spends nothing and asks for login', async () => {
  const { world, run } = await installed();
  world.endSession('refresh_token_invalidated');
  world.advance(HOUR);
  const { code, io } = await run(applyNow, { answers: ['1', 'y'] });
  assert.equal(code, 1);
  assert.equal(io.lines.at(-1), 'Воркер потерял вход в ChatGPT. Войдите заново: `aures login`.');
  assert.equal(world.consumeCalls().length, 0);
});

test('a link of another signed-in Google account finds the project too, and the record keeps the email of the sign-in', async () => {
  const { mac, keychain, project, run } = await installed();
  // Another Mac knows the emails of the accounts only from its own sign-ins.
  const { accounts: _accounts, ...install } = await mac.files.readInstall() ?? {};
  await mac.files.removeAll();
  keychain.entries.clear();
  const { code, io } = await run(status, { answers: [`https://script.google.com/u/1/home/projects/${project.scriptId}/edit`] });
  assert.equal(code, 0, io.output());
  assert.deepEqual(await mac.files.readInstall(), { ...install, accounts: { google: 'owner@example.invalid' } });
});

test('rules on Google switch a rule in the worker and leave this Mac as it is', async () => {
  const { mac, run, property, onlyWebApp } = await installed();
  // Setup left the weekly rule on (issue 24); «2» switches it off.
  const { code, io } = await run(rules, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /1\. Перед истечением \(в последний час\) — включено/);
  assert.match(io.output(), /2\. Когда кончится недельный лимит — включено[\s\S]*2\. Когда кончится недельный лимит — выключено/);
  assert.equal(io.lines.at(-1), 'Правила сохранены и заработают со следующего запуска воркера.');
  assert.deepEqual(property('rules'), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false });
  assert.equal(mac.launchctl.calls.length, 0, 'the rules command does not touch launchctl: the check from this Mac is gone');

  assert.equal((await run(rules, { answers: [''] })).io.lines.at(-1), 'Правила не изменились.');
  onlyWebApp();
});

test('rules on a worker without rules offer both on, as setup sets them (issue 24)', async () => {
  const { gas, run, property } = await installed();
  gas.properties.delete('rules');
  const { code, io } = await run(rules, { answers: [''] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /2\. Когда кончится недельный лимит — включено/);
  assert.deepEqual(property('rules'), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true });
});

test('a Mac without the install record finds the worker on Google by the link to its project', async () => {
  const { world, mac, keychain, project, run } = await installed();
  // Another Mac: no files of the CLI and nothing in the Keychain, nor the emails of the accounts.
  const { accounts: _accounts, ...install } = await mac.files.readInstall() ?? {};
  await mac.files.removeAll();
  keychain.entries.clear();
  world.google.projects.set('fake-other', { scriptId: 'fake-other', title: 'Мой проект', files: [], versions: [], deployments: new Map(),
    serving: null, granted: ['scriptapp', 'external_request'], consentAt: null, gas: null, loaded: null });

  const { code, io } = await run(status, { answers: [`${link(project)}/edit`.replace(project.scriptId, 'nope'),
    `${link(project).replace(project.scriptId, 'fake-other')}/edit`, `${link(project)}/edit`] });
  assert.equal(code, 0, io.output());
  assert.equal(io.asked.filter(question => question.includes('1 или 2')).length, 0, 'there is no platform to choose');
  assert.match(io.output(), /Такого проекта в вашем аккаунте нет\./);
  assert.match(io.output(), /Это проект «Мой проект», а воркер — aures-worker\./);
  assert.ok(world.google.opened.includes(SCRIPT_HOME));
  assert.ok(world.google.opened.some(href => href.startsWith(GOOGLE_LOGIN)));
  assert.match(io.output(), /Воркер найден: https:\/\/script\.google\.com\/macros\/s\/.*\/exec/);
  assert.deepEqual(await mac.files.readInstall(), { ...install, accounts: { google: 'owner@example.invalid' } },
    'the email of the sign-in that found the worker lands in the record');
  assert.equal(await keychain.entries.get('worker-secret'), world.google.deployedSecret(project));
  assert.ok(/СБРОСЫ · 2/.test(io.output()), io.output());

  // From now on the record is there: nothing is asked.
  const again = await run(status);
  assert.deepEqual(again.io.asked, []);
  assert.equal(again.code, 0);
  assert.deepEqual(world.google.violations, []);
});

// A record of the removed GitHub platform counts as no install, and names the repository its
// worker still runs from (ADR-0009) — the first thing a user of that version sees after
// `brew upgrade`.
test('a record of the removed GitHub platform counts as no install: the commands ask for setup and name its repository', async () => {
  const { run, mac } = await cliWorld();
  await mac.files.write('install.json', { platform: 'github' });
  for (const command of [status, applyNow, rules, login]) {
    const { code, io } = await run(command);
    assert.equal(code, 1, io.output());
    assert.deepEqual(io.asked, []);
    assert.deepEqual(io.lines, ['Воркер не установлен. Запустите `aures setup`.',
      'Удалите репозиторий codex-auto-resets-worker в своём аккаунте GitHub ' +
      '(https://github.com/settings/repositories): пока он есть, воркер прежней версии продолжает работать по расписанию и применять сбросы']);
  }
});

test('a foreign record that is not GitHub says nothing of a repository', async () => {
  const { run, mac } = await cliWorld();
  await mac.files.write('install.json', { platform: 'gitlab' });
  const { code, io } = await run(status);
  assert.equal(code, 1);
  assert.deepEqual(io.lines, ['Воркер не установлен. Запустите `aures setup`.']);
});

test('a project found without a deployment is left to setup, which goes on in it', async () => {
  const env = await cliWorld();
  env.world.google.apiEnabled = true;
  env.world.google.failNext = 'create_version';
  assert.equal((await env.run(setup)).code, 1);
  const project = env.world.google.project();
  assert.ok(project);
  await env.mac.files.removeAll();
  env.keychain.entries.delete('worker-secret');

  const { code, io } = await env.run(rules, { answers: [project.scriptId] });
  assert.equal(code, 1);
  assert.equal(io.lines.at(-1), 'Установка не завершена. Запустите `aures setup`.');
  assert.deepEqual(await env.mac.files.readInstall(), { platform: 'google', google: { scriptId: project.scriptId } });
  assert.equal((await env.run(setup, { answers: [] })).code, 0);
  assert.equal(env.world.google.projects.size, 1);
});

test('a worker on Google that does not answer is named with the advice to repair it, and setup repairs it', async () => {
  const { world, mac, secretKeychain, project, run, state, property } = await installed();
  const session = state().session, before = await mac.files.readInstall();

  await secretKeychain.write('another-secret');
  let result = await run(status);
  assert.equal(result.code, 1);
  assert.equal(result.io.lines.at(-1), 'Воркер на Google не отвечает: он не принимает секрет этого Mac. Почините его: `aures setup` заново зальёт воркер.');

  // The user deleted the deployment by hand.
  project.deployments.clear();
  result = await run(status);
  assert.equal(result.code, 1);
  assert.equal(result.io.lines.at(-1), 'Воркер на Google не отвечает: его web app удалён. Почините его: `aures setup` заново зальёт воркер.');

  result = await run(setup, { answers: [] });
  assert.equal(result.code, 0, result.io.output());
  assert.equal(world.google.projects.size, 1);
  assert.equal(project.deployments.size, 1);
  assert.notDeepEqual(await mac.files.readInstall(), before, 'a new deployment has a new URL');
  assert.deepEqual(state().session, session, 'the worker keeps its session');
  assert.deepEqual(property('rules'), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true });
  assert.equal((await run(status)).code, 0);
});

test('setup starts over in a new project when the user deleted the old one', async () => {
  const { world, mac, run } = await installed();
  const [old] = world.google.projects.keys();
  world.google.projects.clear();
  assert.match((await run(status)).io.lines.at(-1) ?? '', /^Воркер на Google не отвечает: его web app удалён\./);

  const { code, io } = await run(setup, { answers: [] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /Проекта воркера в Google больше нет, создаём новый\./);
  const project = world.google.project();
  assert.ok(project && project.scriptId !== old);
  assert.equal((await mac.files.readInstall())?.google?.scriptId, project.scriptId);
  assert.equal((await run(status)).code, 0);
});

test('the screen on Google applies a reset and switches a rule through the worker', async () => {
  const { run, property, journal, project, onlyWebApp } = await installed();
  let screen: Screen | undefined;
  await run(async options => { screen = await openScreen(options); screen.motion = false; return 0; });
  assert.ok(screen);
  const shown = screen;
  const press = async (...names: string[]) => { for (const name of names) await shown.press({ name, sequence: name }); };
  // The link is on the screen «Воркер», not among the resets (issue 03).
  assert.ok(!shown.frame().some(line => line.includes(link(project))), shown.frame().join('\n'));

  await press('down', 'down', 'down', 'return');
  // Setup left the weekly rule on (issue 24), so the screen switches it off here.
  assert.deepEqual(property('rules'), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false });
  assert.match(shown.frame().join('\n'), /☐ Когда кончится недельный лимит/);

  await press('down', 'return', 'y');
  assert.ok(shown.notes.some(note => note.text === 'Сброс reset-b применён.'), shown.frame().join('\n'));
  assert.equal(journal().at(-1)?.kind, 'apply_now');
  assert.match(shown.frame().join('\n'), /СБРОСЫ · 1/);
  onlyWebApp();
});

test('a worker script that failed is told with its message, not as a script without access', () => {
  assert.throws(() => workerDid({ ok: false, error: 'internal', message: 'Service invoked too many times: properties' }, 'status'),
    { message: 'Скрипт воркера упал: Service invoked too many times: properties. Повторите `aures status`.' });
});

// A locked Keychain reads as no secret at all through readSecret; the worker commands tell the
// difference, instead of advice about a secret this Mac does have (ADR-0009).
test('a locked Keychain is not a missing secret: opening the worker says to unlock it', async () => {
  const { run } = await installed();
  const { code, io } = await run(status, { secretKeychain: lockedKeychain() });
  assert.equal(code, 1);
  assert.equal(io.lines.at(-1), 'Связка ключей заблокирована: разблокируйте её и повторите.');
});
