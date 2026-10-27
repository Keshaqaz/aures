import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL } from '../src/cli/launch-agent.ts';
import { fakeMac, leftoverCheck, UID } from './support/fake-mac.ts';
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
