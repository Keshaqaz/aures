import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL, LaunchAgent } from '../src/cli/launch-agent.ts';
import { WatchFiles } from '../src/cli/watch-files.ts';
import { fakeLaunchctl, fakeMac, leftoverCheck, UID } from './support/fake-mac.ts';
import { tempDir } from './support/temp-dir.ts';

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const MAIN = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

test('remove unloads the agent the check from this Mac left and deletes its plist', async () => {
  const mac = await fakeMac();
  await leftoverCheck(mac);
  assert.equal(await mac.agent.remove(), true);
  assert.deepEqual(mac.launchctl.calls, [['bootout', `gui/${UID}/${AGENT_LABEL}`]]);
  assert.equal(mac.launchctl.loaded.size, 0);
  assert.equal(await exists(mac.agent.plistPath), false);
});

test('without a plist there is no agent: remove does not call launchctl', async () => {
  const mac = await fakeMac();
  assert.equal(await mac.agent.remove(), false);
  assert.deepEqual(mac.launchctl.calls, []);
});

test('a plist whose agent is not loaded is deleted all the same', async () => {
  const mac = await fakeMac();
  await leftoverCheck(mac);
  mac.launchctl.loaded.clear();
  assert.equal(await mac.agent.remove(), true);
  assert.equal(await exists(mac.agent.plistPath), false);
});

test('removeLogFolder deletes the folder with the log', async () => {
  const mac = await fakeMac();
  await leftoverCheck(mac);
  await mac.agent.removeLogFolder();
  assert.equal(await exists(mac.agent.logPath), false);
});

// The agent runs `aures watch` every 2 minutes; with no plist in this home there is nothing to
// unload, so the real launchctl is never reached.
test('watch, which the left agent runs, prints nothing and ends with 0', async () => {
  const home = await tempDir('watch-home-');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [MAIN, 'watch'], { env: { ...process.env, HOME: home } });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

// The agent's own bootout kills the `aures watch` process that runs remove, as a launchctl that
// never answers: the plist has to be gone before it, or it stays for the next login.
test('remove deletes the plist before bootout, which kills the process that runs it', async () => {
  const mac = await fakeMac();
  await leftoverCheck(mac);
  let plistAtBootout: boolean | null = null;
  let killed: () => void = () => {};
  mac.agent.launchctl = async args => {
    mac.launchctl.calls.push(args);
    plistAtBootout = await exists(mac.agent.plistPath);
    await new Promise<void>(resolve => { killed = resolve; });
    return { code: 0 };
  };
  const removing = mac.agent.remove();
  for (let i = 0; i < 200 && plistAtBootout === null; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(mac.launchctl.calls.length, 1, 'bootout is reached');
  assert.equal(plistAtBootout, false, 'the plist is already gone when bootout runs');
  assert.equal(await exists(mac.agent.plistPath), false);
  killed();
  assert.equal(await removing, true);
});

// watch removes everything the check from this Mac left on its own: the agent, its log, the
// computer session and watch.json; the files of this install stay (ADR-0009).
test('watch, which the left agent runs, removes the session and watch.json, the log and the agent, and prints nothing', async () => {
  const home = await tempDir('watch-home-');
  const files = new WatchFiles({ dir: join(home, 'Library', 'Application Support', 'codex-auto-resets') });
  const agent = new LaunchAgent({ home, uid: UID });
  await leftoverCheck({ home, launchctl: fakeLaunchctl(), agent, files });
  await files.writeInstall({ platform: 'google' });
  await files.writeLanguage('ru');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [MAIN, 'watch'], { env: { ...process.env, HOME: home } });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
  assert.equal(await exists(agent.plistPath), false);
  assert.equal(await exists(agent.logPath), false);
  assert.equal(await files.read('chatgpt-session.json'), null);
  assert.equal(await files.read('watch.json'), null);
  assert.deepEqual(await files.readInstall(), { platform: 'google' }, 'the install record stays');
  assert.equal(await files.readLanguage(), 'ru', 'settings.json stays');
});
