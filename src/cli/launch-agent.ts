import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { rm, stat } from 'node:fs/promises';

// The launchd agent left behind by versions with the check from this Mac (ADR-0005): it runs
// `aures watch` every 2 minutes. The check is gone (ADR-0009), so the agent is only removed —
// by `watch` itself, `upgrade` and `uninstall`.
export const AGENT_LABEL = 'com.github.keshaqaz.codex-auto-resets.watch';
const LAUNCHCTL = '/bin/launchctl';

// One launchctl command and its exit code; -1 when it cannot run.
export type Launchctl = (args: string[]) => Promise<{ code: number }>;

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

const runLaunchctl: Launchctl = args => new Promise(resolve => execFile(LAUNCHCTL, args, { timeout: 30_000 },
  error => resolve({ code: !error ? 0 : typeof error.code === 'number' && Number.isInteger(error.code) ? error.code : -1 })));

export interface LaunchAgentOptions {
  home?: string;
  uid?: number;
  launchctl?: Launchctl;
}

export class LaunchAgent {
  home: string;
  uid: number;
  launchctl: Launchctl;
  plistPath: string;
  logPath: string;
  // getuid is missing only off POSIX, where aures does not run.
  constructor({ home = homedir(), uid = process.getuid?.() ?? -1, launchctl = runLaunchctl }: LaunchAgentOptions = {}) {
    this.home = home;
    this.uid = uid;
    this.launchctl = launchctl;
    this.plistPath = join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
    this.logPath = join(home, 'Library', 'Logs', 'codex-auto-resets', 'watch.log');
  }

  // Unloads the agent and deletes its plist. Without a plist there is no agent, and launchctl
  // is not called. True when the plist was there.
  async remove(): Promise<boolean> {
    if (!await exists(this.plistPath)) return false;
    await this.launchctl(['bootout', this.target]);
    await rm(this.plistPath, { force: true });
    return true;
  }

  async removeLogFolder(): Promise<void> { await rm(dirname(this.logPath), { recursive: true, force: true }); }
  get target(): string { return `gui/${this.uid}/${AGENT_LABEL}`; }
}
