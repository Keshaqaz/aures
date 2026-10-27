// This Mac as the CLI sees it: launchctl, the LaunchAgents and Logs folders and the install
// files, all in a temporary home.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LaunchAgent, AGENT_LABEL } from '../../src/cli/launch-agent.ts';
import type { Launchctl } from '../../src/cli/launch-agent.ts';
import { MacFiles } from '../../src/cli/mac-files.ts';
import type { Mac } from '../../src/cli/common.ts';
import { tempDir } from './temp-dir.ts';

export const UID = 501;

// launchctl for one user's GUI domain, exit codes as launchctl gives them: bootout of an agent
// that is not loaded answers 3.
export interface FakeLaunchctl {
  loaded: Set<string>; // labels of the loaded agents
  calls: string[][];
  run: Launchctl;
}
export function fakeLaunchctl(): FakeLaunchctl {
  const launchctl: FakeLaunchctl = {
    loaded: new Set(),
    calls: [],
    run: async args => {
      launchctl.calls.push(args);
      const [verb, target = ''] = args;
      if (target.split('/')[1] !== String(UID)) return { code: 125 };
      const label = target.split('/')[2] ?? '';
      if (verb === 'bootout') return { code: launchctl.loaded.delete(label) ? 0 : 3 };
      return { code: 64 };
    },
  };
  return launchctl;
}

export interface FakeMac extends Mac { home: string; launchctl: FakeLaunchctl }
export async function fakeMac(): Promise<FakeMac> {
  const home = await tempDir('fake-mac-');
  const launchctl = fakeLaunchctl();
  const agent = new LaunchAgent({ home, uid: UID, launchctl: launchctl.run });
  const files = new MacFiles({ dir: join(home, 'Library', 'Application Support', 'codex-auto-resets') });
  return { home, launchctl, agent, files };
}

// What the check from this Mac of an earlier version (ADR-0005) left: its agent loaded from its
// plist, its log, and the computer session and watch.json next to the install record.
export async function leftoverCheck(mac: FakeMac): Promise<void> {
  await mkdir(dirname(mac.agent.plistPath), { recursive: true });
  await writeFile(mac.agent.plistPath, `<plist><dict><key>Label</key><string>${AGENT_LABEL}</string></dict></plist>\n`);
  mac.launchctl.loaded.add(AGENT_LABEL);
  await mkdir(dirname(mac.agent.logPath), { recursive: true });
  await writeFile(mac.agent.logPath, '2026-10-20T05:02:21+07:00 idle\n');
  await mac.files.write('chatgpt-session.json', { accessToken: 'a', refreshToken: 'r', accountId: 'acc' });
  await mac.files.write('watch.json', { lastPass: { at: 0, outcome: 'idle' } });
}
