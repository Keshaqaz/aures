import { setupGoogle } from './setup-google.ts';
import { Stages, command, capitalized, githubRepoStep } from './common.ts';
import type { CommandOptions } from './common.ts';
import { t } from './language.ts';

// `aures setup`: from nothing to a working worker, or the missing parts of an existing one,
// on Google Apps Script (ADR-0009), in four stages. An install record that names no worker on
// Google counts as no install: setup starts over and overwrites it. Returns the process exit code.
// appsScriptSource is the Apps Script bundle; openScreen is what a terminal setup does when it
// is done (issue 30): setup tells the user and hands over as its last step. main passes one
// that opens the screen after the command's own readline is closed — stdin must have one
// reader while the screen runs; tests inject their own to see that the hand-over comes after
// everything setup has to say.
export interface SetupOptions extends CommandOptions {
  appsScriptSource: string;
  openScreen?: () => Promise<number>;
}
export async function setup(options: SetupOptions): Promise<number> {
  const { io, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  const code = await command('setup', io, async () => {
    // The worker of the removed GitHub platform (ADR-0009) keeps running while its repository is
    // there: the user learns it here, before the record of that version is overwritten.
    if (await mac.files.githubInstall()) io.print(capitalized(githubRepoStep()));
    // A record without a worker on Google counts as no install (ADR-0009): it is written anew
    // before the stages, so that the sign-ins have a record to keep their accounts in.
    const install = await mac.files.readInstall();
    if (!install) await mac.files.writeInstall({ platform: 'google' });
    const paused = install?.paused === true;
    const stages = new Stages(io, 4);
    try {
      return await setupGoogle({ ...options, now, sleep, paused, stages });
    } finally { io.wait(null); }
  });
  // A successful setup in a terminal opens the screen (issue 30): the resets and the rules it
  // just made are what the screen shows. This is setup's last step — tell the user and hand
  // over — so that by the time the screen runs, setup itself is done. Outside a terminal, or
  // after a failure, setup ends as any other command.
  if (code !== 0 || !options.openScreen) return code;
  io.print(t('Opening aures…', 'Открываю aures…'));
  return options.openScreen();
}
