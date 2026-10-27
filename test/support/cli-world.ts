// The fake world a CLI command runs in: ChatGPT, auth.openai.com, Google with Apps Script, a
// Keychain and a user at the terminal.
import { fakeWorld, credit } from './fake-world.ts';
import { withGoogle } from './fake-google.ts';
import { bundle } from './fake-apps-script.ts';
import type { FakeGoogle } from './fake-google.ts';
import { fakeMac } from './fake-mac.ts';
import type { FakeWorld } from './fake-world.ts';
import type { FakeMac } from './fake-mac.ts';
import { setLanguage } from '../../src/cli/language.ts';
import type { Language } from '../../src/cli/language.ts';
import type { CommandOptions, Io } from '../../src/cli/common.ts';
import { GITHUB_TOKEN_ACCOUNT, GOOGLE_TOKEN_ACCOUNT, WORKER_SECRET_ACCOUNT } from '../../src/cli/keychain.ts';
import type { Keychain } from '../../src/cli/keychain.ts';

const HOUR = 3600_000, DAY = 24 * HOUR;

// The user at the terminal: approves each device code as soon as it is shown and answers
// prompts from a script (an empty line is Enter). waits are the texts of the live line, null
// where it went away; a code shown as the live line — the stage line of setup (issue 30) — is
// entered as soon as one shown by print.
export interface Terminal extends Io {
  lines: string[];
  asked: string[];
  waits: (string | null)[];
  output(): string;
}
export type CliFakeWorld = FakeWorld & { google: FakeGoogle };

export function terminal(world: CliFakeWorld, answers: string[] = []): Terminal {
  const lines: string[] = [], asked: string[] = [], waits: (string | null)[] = [];
  const shown = (text: string | null): void => {
    for (const [code] of (text ?? '').matchAll(/FAKE-\d+/g)) world.approve(code);
  };
  return {
    lines, asked, waits,
    wait: text => { waits.push(text); shown(text); },
    output: () => lines.join('\n'),
    print: line => {
      lines.push(line);
      shown(line);
    },
    prompt: async question => {
      asked.push(question);
      lines.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      return answer;
    },
  };
}

// One entry of the macOS Keychain, by its account; entries are all of them, by account.
export interface FakeKeychain extends Keychain { entries: Map<string, string> }
export function fakeKeychain(account = GITHUB_TOKEN_ACCOUNT, entries = new Map<string, string>()): FakeKeychain {
  return { entries, read: async () => entries.get(account) ?? null,
    write: async token => { entries.set(account, token); }, remove: async () => { entries.delete(account); } };
}

// What run hands a command, enough for any of them; a test overrides some for one command.
// githubKeychain is the GitHub sign-in an earlier version left, which uninstall removes.
export interface WorldOptions extends CommandOptions {
  appsScriptSource: string;
  githubKeychain: Keychain;
  googleKeychain: Keychain;
  secretKeychain: Keychain;
  open: (url: string) => Promise<void>;
  copy: (text: string) => Promise<boolean>;
}
export type RunOptions = Partial<WorldOptions> & { answers?: string[]; openScreen?: () => Promise<number> };
export interface CliWorld {
  world: CliFakeWorld;
  // The GitHub sign-in an earlier version left; its entries are those of the whole Keychain.
  keychain: FakeKeychain;
  // The Google refresh token and the worker's doPost secret, in the same Keychain.
  googleKeychain: FakeKeychain;
  secretKeychain: FakeKeychain;
  mac: FakeMac;
  // Every text the commands copied to the clipboard, in order.
  copied: string[];
  run(command: (options: WorldOptions) => Promise<number>, options?: RunOptions): Promise<{ code: number; io: Terminal }>;
}

// run(command, { answers, ...options }) runs one CLI command, e.g. setup, against the world and
// this Mac and resolves to { code, io }. The tests read the Russian texts unless they ask for
// another language.
export async function cliWorld({ language = 'ru' }: { language?: Language } = {}): Promise<CliWorld> {
  setLanguage(language);
  const base = fakeWorld();
  base.chatgpt.credits = [credit('reset-a', base.now + 5 * DAY), credit('reset-b', base.now + 2 * DAY + 3 * HOUR)];
  const world = Object.assign(base, { google: withGoogle(base) });
  const keychain = fakeKeychain();
  const googleKeychain = fakeKeychain(GOOGLE_TOKEN_ACCOUNT, keychain.entries),
    secretKeychain = fakeKeychain(WORKER_SECRET_ACCOUNT, keychain.entries);
  const mac = await fakeMac();
  const appsScriptSource = await bundle();
  const copied: string[] = [];
  const run: CliWorld['run'] = (command, { answers = [], ...options } = {}) => {
    const io = terminal(world, answers);
    // The clipboard succeeds and keeps what was copied, unless a test brings its own.
    const copy: WorldOptions['copy'] = async text => { copied.push(text); return true; };
    const done = command({ fetch: world.fetch, githubKeychain: keychain, io, now: () => world.now, sleep: async ms => world.advance(ms),
      appsScriptSource, googleKeychain, secretKeychain, open: world.google.open, copy, timeZone: 'UTC', mac,
      ...options });
    return done.then(code => ({ code, io }));
  };
  return { world, keychain, googleKeychain, secretKeychain, mac, copied, run };
}
