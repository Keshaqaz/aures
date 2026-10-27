import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/cli/setup.ts';
import { openWorker } from '../src/cli/active-worker.ts';
import type { Worker } from '../src/cli/active-worker.ts';
import { readJournal } from '../src/cli/journal.ts';
import { cliWorld } from './support/cli-world.ts';
import type { CliWorld } from './support/cli-world.ts';

const MINUTE = 60_000;

// The worker of an install the user made, opened the way the commands open it.
async function opened(env: CliWorld): Promise<Worker> {
  let worker: Worker | null = null;
  const { code } = await env.run(async options => {
    worker = await openWorker(options, null);
    return 0;
  });
  assert.equal(code, 0);
  assert.ok(worker);
  return worker;
}

// A worker installed by setup, with its login and its trial run.
async function installed(): Promise<CliWorld> {
  const env = await cliWorld();
  const { code, io } = await env.run(setup);
  assert.equal(code, 0, io.output());
  return env;
}

test('the journal gives the entries of the ring buffer, oldest first, each with its time, kind, outcome and length', async () => {
  // Setup left a login and a trial run, the schedule ran once more before the poll.
  const env = await installed();
  const gas = env.world.google.project()?.gas;
  assert.ok(gas, 'setup deploys the worker');
  env.world.advance(5 * MINUTE);
  gas.tick();
  const worker = await opened(env);

  const { entries } = await readJournal(worker, { now: () => env.world.now });
  assert.deepEqual(entries.map(entry => entry.kind), ['login', 'trial', 'scheduled']);
  assert.deepEqual(entries.map(entry => entry.outcome), ['idle', 'idle', 'idle']);
  assert.ok(entries.every(({ at, durationMs }) => typeof at === 'string' && Number.isFinite(durationMs) && durationMs >= 0));
  assert.ok(entries.every((entry, i, all) => i === 0 || Date.parse(all[i - 1]?.at ?? '') <= Date.parse(entry.at)),
    'the entries read oldest first, as the ring buffer keeps them');
  assert.deepEqual(env.world.google.violations, []);
});

test('the time the worker took to answer comes back with the entries', async () => {
  const env = await installed();
  const earlier = env.world.fetch;
  env.world.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://script.google.com/macros/') && (init.method ?? 'GET') === 'POST') env.world.advance(1500);
    return earlier(input, init);
  };
  const worker = await opened(env);
  await readJournal(worker, { now: () => env.world.now }); // the opening status, not a poll yet
  const polled = await readJournal(worker, { now: () => env.world.now });
  assert.equal(polled.responseMs, 1500);
  assert.equal(polled.readAt, env.world.now - 1500);
  assert.deepEqual(polled.entries.map(entry => entry.kind), ['login', 'trial']);
});
