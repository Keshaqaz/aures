import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import type { Language } from './language.ts';

// What the CLI keeps on this Mac: settings.json with the language of the CLI and install.json
// with the worker. The check from this Mac of earlier versions (ADR-0005) kept its session and
// watch.json here too; they go with the folder at `uninstall` (removeAll).
export const SUPPORT_DIR = join(homedir(), 'Library', 'Application Support', 'codex-auto-resets');
const SETTINGS = 'settings.json', INSTALL = 'install.json';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// Where the worker of this install lives (ADR-0009: the platform is one, Google Apps
// Script). On Google: its project as soon as it exists, then the deployment and the URL of
// its web app. An install record that names no worker on Google — one of the removed GitHub
// platform — counts as no install at all.
export interface Install { platform: 'google'; paused?: true; google?: GoogleWorker; accounts?: Accounts }
export interface GoogleWorker { scriptId: string; deploymentId?: string; url?: string }
// The accounts the screen «Воркер» names: the email of the Google account the CLI signed in to
// and of the ChatGPT account of the worker session, as the sign-ins gave them. An email only:
// never a token.
export type Account = 'google' | 'chatgpt';
export type Accounts = Partial<Record<Account, string>>;
const isGoogleWorker = (value: unknown): value is GoogleWorker => object(value) && typeof value.scriptId === 'string' &&
  ['deploymentId', 'url'].every(key => value[key] === undefined || typeof value[key] === 'string');
const accountsOf = (value: unknown): Accounts => Object.fromEntries((['google', 'chatgpt'] as const)
  .flatMap(account => object(value) && typeof value[account] === 'string' ? [[account, value[account]]] : []));

export interface WatchFilesOptions { dir?: string }

export class WatchFiles {
  dir: string;
  constructor({ dir = SUPPORT_DIR }: WatchFilesOptions = {}) { this.dir = dir; }
  // null when the file is missing or does not parse.
  async read(name: string): Promise<unknown> {
    try { return JSON.parse(await readFile(join(this.dir, name), 'utf8')); } catch { return null; }
  }
  // Written aside and renamed, so a crash never leaves half a file.
  async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, name), aside = `${file}.tmp`;
    await writeFile(aside, JSON.stringify(value), { mode: 0o600 });
    await rename(aside, file);
  }

  // The language the user picked, or null.
  async readLanguage(): Promise<unknown> {
    const settings = await this.read(SETTINGS);
    return object(settings) ? settings.language ?? null : null;
  }
  async writeLanguage(language: Language): Promise<void> {
    const settings = await this.read(SETTINGS);
    await this.write(SETTINGS, { ...object(settings) ? settings : {}, language });
  }
  // The install record of a worker on Google, or null when there is none: no record, one that
  // does not parse, or one of the removed GitHub platform (ADR-0009), which counts as no
  // install — see foreignInstall.
  async readInstall(): Promise<Install | null> {
    const install = await this.read(INSTALL);
    if (!object(install) || install.platform !== 'google') return null;
    const accounts = accountsOf(install.accounts);
    return { platform: 'google', ...install.paused === true ? { paused: true } : {},
      ...isGoogleWorker(install.google) ? { google: install.google } : {}, ...Object.keys(accounts).length ? { accounts } : {} };
  }
  // An install record is there, but it names no worker on Google: the GitHub platform of an
  // earlier version (ADR-0009). It counts as no install, only `aures setup` can go on.
  async foreignInstall(): Promise<boolean> {
    const install = await this.read(INSTALL);
    return object(install) && install.platform !== 'google';
  }
  async writeInstall(install: Install): Promise<void> { await this.write(INSTALL, install); }
  // Keeps the email of an account just signed in to in the install record; nothing without one.
  async rememberAccount(account: Account, email: string | null): Promise<void> {
    const install = await this.readInstall();
    if (install && email) await this.writeInstall({ ...install, accounts: { ...install.accounts, [account]: email } });
  }
  // The folder with everything in it, for uninstall.
  async removeAll(): Promise<void> { await rm(this.dir, { recursive: true, force: true }); }
  // One file of the folder, gone when it is not there: what earlier versions left beside the
  // install record goes on its own, without the folder (ADR-0009).
  async remove(name: string): Promise<void> { await rm(join(this.dir, name), { force: true }); }
}
