import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/cli/setup.ts';
import { status } from '../src/cli/status.ts';
import { upgrade } from '../src/cli/upgrade.ts';
import { uninstall } from '../src/cli/uninstall.ts';
import { KeychainUnavailable } from '../src/cli/keychain.ts';
import type { Keychain } from '../src/cli/keychain.ts';
import { cliWorld } from './support/cli-world.ts';
import { leftoverCheck } from './support/fake-mac.ts';
import { bundle } from './support/fake-apps-script.ts';
import { stat } from 'node:fs/promises';
import type { FakeProject } from './support/fake-google.ts';

const GOOGLE_LOGIN = 'https://accounts.google.com/';
const CONNECTIONS = 'https://myaccount.google.com/connections';
const REPOSITORIES = 'https://github.com/settings/repositories';
const LOCKED_KEYCHAIN = 'Связка ключей недоступна: удалите в ней запись codex-auto-resets вручную.';
const REPO_STEP = 'удалите репозиторий codex-auto-resets-worker в своём аккаунте GitHub ' +
  `(https://github.com/settings/repositories): пока он есть, воркер прежней версии продолжает работать по расписанию и применять сбросы`;
// A Keychain that does not answer, as a locked one.
const lockedKeychain = (): Keychain => ({
  read: async () => { throw new KeychainUnavailable(); },
  write: async () => {},
  remove: async () => {},
});
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const link = (project: FakeProject): string => `https://script.google.com/home/projects/${project.scriptId}`;

// A worker installed on Google by setup with the default rules.
async function onGoogle() {
  const env = await cliWorld();
  const { code, io } = await env.run(setup);
  assert.equal(code, 0, io.output());
  const project = env.world.google.project();
  assert.ok(project?.gas);
  return { ...env, project, gas: project.gas };
}

test('upgrade on Google puts the new bundle into the same deployment: the URL, the state and the schedule stay', async () => {
  const { world, mac, project, gas, secretKeychain, run } = await onGoogle();
  const install = await mac.files.readInstall();
  const [deploymentId] = [...project.deployments.keys()];
  const properties = new Map(gas.properties);
  const versions = project.versions.length;
  const next = `${await bundle()}\n// next version\n`;
  const opened = world.google.opened.length;

  const { code, io } = await run(upgrade, { appsScriptSource: next });
  assert.equal(code, 0, io.output());
  assert.deepEqual([...project.deployments], [[deploymentId, versions + 1]]);
  assert.equal(project.files.find(file => file.name === 'worker')?.source, next);
  assert.deepEqual(await mac.files.readInstall(), install);
  assert.equal(await secretKeychain.read(), world.google.deployedSecret());
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.deepEqual(new Map([...gas.properties].filter(([key]) => key !== 'journal')),
    new Map([...properties].filter(([key]) => key !== 'journal')));
  assert.match(io.lines.at(-1) ?? '', /^Воркер обновлён до версии \d+\.\d+\.\d+\. Изменения заработают со следующего запуска\.$/);
  assert.deepEqual(world.google.opened.slice(opened), [], 'the kept sign-in is used');

  // The worker answers this Mac under the same URL with the new secret.
  const shown = await run(status);
  assert.equal(shown.code, 0, shown.io.output());
  assert.ok(shown.io.lines.includes('╭─ СБРОСЫ · 2'), shown.io.output());
  assert.deepEqual(world.google.violations, []);
});

test('upgrade on Google with a sign-in Google ended opens the sign-in and goes on', async () => {
  const { world, project, run } = await onGoogle();
  world.google.expireRefreshTokens();
  const opened = world.google.opened.length;
  const versions = project.versions.length;
  const { code, io } = await run(upgrade);
  assert.equal(code, 0, io.output());
  assert.ok(world.google.opened.slice(opened).some(href => href.startsWith(GOOGLE_LOGIN)), io.output());
  assert.equal(project.versions.length, versions + 1);
  assert.match(io.lines.at(-1) ?? '', /^Воркер обновлён до версии/);
});

// The review of issue 29: a script whose consent lost a box answers 'scopes' after the deploy, and
// upgrade says to redo the consent at `aures setup` instead of a vague failure.
test('upgrade on Google over a consent without every box says to redo the consent', async () => {
  const { project, run } = await onGoogle();
  project.granted = ['scriptapp'];
  const { code, io } = await run(upgrade);
  assert.equal(code, 1, io.output());
  assert.match(io.output(), /Скрипту воркера на согласии выданы не все доступы: отмечены не все галочки\. Запустите `aures setup`/);
});

// The web app keeps answering with the previous version of the deployment for a few seconds;
// the upgrade waits it out instead of trusting the first answer (issue 20).
test('upgrade on Google waits out a web app still serving the previous version', async () => {
  const { world, project, gas, secretKeychain, run } = await onGoogle();
  world.google.servePrevious = 2;
  const [deploymentId] = [...project.deployments.keys()];
  const versions = project.versions.length;
  const next = `${await bundle()}\n// next version\n`;

  const { code, io } = await run(upgrade, { appsScriptSource: next });
  assert.equal(code, 0, io.output());
  assert.ok(io.waits.includes('Ждём, когда Google начнёт отдавать новую версию воркера…'), io.output());
  assert.deepEqual([...project.deployments], [[deploymentId, versions + 1]]);
  assert.equal(await secretKeychain.read(), world.google.deployedSecret());
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.match(io.lines.at(-1) ?? '', /^Воркер обновлён до версии/);
  assert.deepEqual(world.google.violations, []);
});

test('upgrade on Google sends a deleted project or deployment to setup', async () => {
  const { world, project, run } = await onGoogle();
  project.deployments.clear();
  let result = await run(upgrade);
  assert.equal(result.code, 1);
  assert.equal(result.io.lines.at(-1), 'Проекта или развёртывания воркера в Google больше нет. Запустите `aures setup`: он развернёт воркер заново.');
  world.google.projects.clear();
  result = await run(upgrade);
  assert.equal(result.code, 1);
  assert.equal(result.io.lines.at(-1), 'Проекта или развёртывания воркера в Google больше нет. Запустите `aures setup`: он развернёт воркер заново.');
});

test('uninstall on Google stops the worker, deletes its web app, ends the Google sign-in and names the manual steps', async () => {
  const { world, mac, keychain, project, gas, run } = await onGoogle();
  const session = JSON.parse(gas.properties.get('state') ?? 'null').session as { refreshToken: string };
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), new RegExp(`Будут удалены воркер на Google \\(${link(project)}`));
  assert.deepEqual(gas.triggers, []);
  assert.equal(gas.authInvalidated, true);
  assert.deepEqual(world.auth.revoked, [session.refreshToken]);
  assert.equal(project.deployments.size, 0);
  assert.equal(world.google.refreshTokens.size, 0, 'the Google sign-in is revoked');
  assert.equal(keychain.entries.size, 0);
  assert.equal(await mac.files.readInstall(), null);
  assert.deepEqual(io.lines.slice(-5), [
    'Воркер на Google остановлен, его вход в ChatGPT отозван.',
    'Web app воркера на Google удалён.',
    'Вход aures в Google отозван.',
    'Вход в Google и секрет воркера удалены из Связки ключей.',
    `Последний шаг: удалите проект aures-worker на странице ${link(project)}`,
  ]);
  assert.ok(!io.output().includes(CONNECTIONS), 'the stopped worker left no entry to check for');
  assert.deepEqual(world.google.violations, []);
});

test('upgrade removes all the check from this Mac left: the agent, its log, the session and watch.json; the files of this install stay', async () => {
  const { mac, run } = await onGoogle();
  await leftoverCheck(mac);
  await mac.files.writeLanguage('ru');
  const { code, io } = await run(upgrade);
  assert.equal(code, 0, io.output());
  assert.equal(mac.launchctl.loaded.size, 0);
  assert.equal(await exists(mac.agent.plistPath), false);
  assert.equal(await exists(mac.agent.logPath), false);
  assert.equal(await mac.files.read('chatgpt-session.json'), null);
  assert.equal(await mac.files.read('watch.json'), null);
  assert.ok(await mac.files.readInstall(), 'the install record stays');
  assert.equal(await mac.files.readLanguage(), 'ru', 'settings.json stays');
});

// The leftovers go even when there is no install to upgrade — a GitHub record of an earlier
// version, or none at all (ADR-0009).
test('upgrade with no install to upgrade still removes what the check from this Mac left', async () => {
  const { mac, run } = await cliWorld();
  await leftoverCheck(mac);
  const { code } = await run(upgrade);
  assert.equal(code, 1);
  assert.equal(await exists(mac.agent.plistPath), false);
  assert.equal(await exists(mac.agent.logPath), false);
  assert.equal(await mac.files.read('chatgpt-session.json'), null);
  assert.equal(await mac.files.read('watch.json'), null);
});

test('uninstall removes what earlier versions left: the agent and log of the check from this Mac, its files and the GitHub sign-in', async () => {
  const { mac, keychain, project, run } = await onGoogle();
  await leftoverCheck(mac);
  keychain.entries.set('github', 'gho_left');
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.equal(mac.launchctl.loaded.size, 0);
  assert.equal(await exists(mac.agent.plistPath), false);
  assert.equal(await exists(mac.agent.logPath), false);
  assert.equal(await exists(mac.files.dir), false, 'the computer session and watch.json go with the folder');
  assert.equal(keychain.entries.size, 0);
  assert.deepEqual(io.lines.slice(-3), [
    'Проверка с этого Mac от прежней версии удалена.',
    'Вход в GitHub от прежней версии удалён из Связки ключей.',
    `Последний шаг: удалите проект aures-worker на странице ${link(project)}`,
  ]);
});

test('uninstall over a record of the removed GitHub platform cleans this Mac and asks nothing', async () => {
  const { mac, keychain, run } = await cliWorld();
  await mac.files.write('install.json', { platform: 'github' });
  await leftoverCheck(mac);
  keychain.entries.set('github', 'gho_left');
  const { code, io } = await run(uninstall);
  assert.equal(code, 0, io.output());
  assert.deepEqual(io.asked, []);
  assert.equal(await exists(mac.files.dir), false);
  assert.equal(await exists(mac.agent.plistPath), false);
  assert.equal(keychain.entries.size, 0);
});

test('uninstall on Google with a worker that does not answer names the access to take back for sure', async () => {
  const { project, gas, secretKeychain, run } = await onGoogle();
  await secretKeychain.remove();
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('Воркер на Google не ответил: в Связке ключей этого Mac нет секрета воркера. ' +
    'Его расписание и вход в ChatGPT удалятся вместе с проектом.'), io.output());
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.equal(project.deployments.size, 0);
  assert.equal(io.lines.at(-1), `  2. Закройте доступ aures-worker на странице ${CONNECTIONS}`);
});

test('uninstall on Google names the aures access when Google does not end the sign-in', async () => {
  const { world, run } = await onGoogle();
  world.google.revokeFail = 503;
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(!io.lines.includes('Вход aures в Google отозван.'));
  assert.equal(io.lines.at(-1), `  2. Закройте доступ aures на странице ${CONNECTIONS}`);
});

test('uninstall on Google deletes nothing until the user confirms', async () => {
  const { world, keychain, project, gas, run } = await onGoogle();
  const entries = keychain.entries.size;
  const { code, io } = await run(uninstall, { answers: [''] });
  assert.equal(code, 0);
  assert.equal(io.lines.at(-1), 'Отменено.');
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.equal(project.deployments.size, 1);
  assert.ok(world.google.refreshTokens.size > 0);
  assert.equal(keychain.entries.size, entries);
});

test('uninstall on Google goes on when the web app cannot be deleted, and leaves it to the project', async () => {
  const { world, keychain, mac, run } = await onGoogle();
  world.google.failNext = 'delete_deployment';
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('Web app воркера на Google не удалён (delete_deployment_500). Он удалится вместе с проектом.'), io.output());
  assert.equal(world.google.refreshTokens.size, 0);
  assert.equal(keychain.entries.size, 0);
  assert.equal(await mac.files.readInstall(), null);
});

test('uninstall after a setup on Google cut short before the deploy names only the project to delete', async () => {
  const { world, mac, keychain, run } = await cliWorld();
  await mac.files.writeInstall({ platform: 'google', google: { scriptId: 'fake-script-cut' } });
  keychain.entries.set('google', '1//fake-left-behind');
  world.google.refreshTokens.set('1//fake-left-behind', []);
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.equal(world.google.refreshTokens.size, 0);
  assert.equal(keychain.entries.size, 0);
  assert.equal(io.lines.at(-1), 'Последний шаг: удалите проект aures-worker на странице https://script.google.com/home/projects/fake-script-cut');
});

test('uninstall with nothing on this Mac says there is nothing to remove', async () => {
  const { run } = await cliWorld();
  const { code, io } = await run(uninstall);
  assert.equal(code, 0);
  assert.deepEqual(io.lines, ['aures на этом Mac не установлен: удалять нечего.']);
});

test('uninstall with only the files of this Mac says they are removed', async () => {
  const { mac, run } = await cliWorld();
  await mac.files.writeLanguage('ru');
  const { code, io } = await run(uninstall);
  assert.equal(code, 0);
  assert.deepEqual(io.lines, ['Файлы aures на этом Mac удалены.']);
  assert.equal(await exists(mac.files.dir), false);
});

test('uninstall over a GitHub record names the repository its worker still runs from', async () => {
  const { run, mac } = await cliWorld();
  await mac.files.write('install.json', { platform: 'github' });
  const { code, io } = await run(uninstall);
  assert.equal(code, 0, io.output());
  assert.deepEqual(io.lines, [`Последний шаг: ${REPO_STEP}`]);
});

test('uninstall on Google prints no step about GitHub', async () => {
  const { project, run } = await onGoogle();
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(!io.output().includes('codex-auto-resets-worker'), io.output());
  assert.equal(io.lines.at(-1), `Последний шаг: удалите проект aures-worker на странице ${link(project)}`);
});

test('a locked Keychain in the leftovers is named once when the Google entries named it already', async () => {
  const { googleKeychain, run } = await onGoogle();
  // The Google entries cannot be removed; the GitHub one cannot even be read.
  const notRemoved: Keychain = { ...googleKeychain, remove: async () => { throw new KeychainUnavailable(); } };
  const { code, io } = await run(uninstall, { answers: ['y'], googleKeychain: notRemoved, githubKeychain: lockedKeychain() });
  assert.equal(code, 0, io.output());
  assert.equal(io.lines.filter(line => line === LOCKED_KEYCHAIN).length, 1, io.output());
});

test('a locked Keychain with nothing else to remove is named on its own', async () => {
  const { run } = await cliWorld();
  const { code, io } = await run(uninstall, { githubKeychain: lockedKeychain() });
  assert.equal(code, 0);
  assert.deepEqual(io.lines, [LOCKED_KEYCHAIN]);
});
