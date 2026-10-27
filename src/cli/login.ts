import { randomUUID } from 'node:crypto';
import { deviceLogin, sessionEmail } from '../chatgpt/session.ts';
import { CommandFailed, chatgptLogin, showCode, workingLine, command } from './common.ts';
import type { CommandOptions, Io, Sleep } from './common.ts';
import { openWorker } from './active-worker.ts';
import type { Worker } from './active-worker.ts';
import type { MacFiles } from './mac-files.ts';
import { brokenOnGoogle } from './google.ts';
import type { Fetch } from '../chatgpt/http.ts';
import type { OpenUrl, CopyText } from './browser.ts';
import type { Summary } from '../worker/summary.ts';
import { t } from './language.ts';

const otherAccount = (): string => t('This is another ChatGPT account, the sign-in is rejected. Sign in to the one the worker was set up for. ' +
  'To change the account, reinstall the worker: `aures uninstall`, then `aures setup`.',
'Это другой аккаунт ChatGPT, вход отклонён. Войдите в тот, для которого установлен воркер. ' +
  'Чтобы сменить аккаунт, переустановите воркер: `aures uninstall`, затем `aures setup`.');

export const renewed = (): string => t('The sign-in is renewed, the rules and history are in place.', 'Вход обновлён, правила и история на месте.');
const unavailable = (): string => t('ChatGPT is temporarily unavailable: the resets will be read on the next run.',
  'ChatGPT временно недоступен: сбросы прочитаются при следующем запуске.');

// `aures login`: a new worker session after the old one is lost. The worker takes it in place
// of the old one, keeping rules and history, and rejects another ChatGPT account.
export async function login(options: CommandOptions): Promise<number> {
  const { fetch, io, open, copy, mac: { files }, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone } = options;
  return command('login', io, async () => signInAgain(await openWorker(options, 'login'), { fetch, io, files, open, copy, now, sleep, timeZone }));
}
// files keeps the email of the account signed in to.
export interface LoggingIn { fetch: Fetch; io: Io; files: Pick<MacFiles, 'rememberAccount'>; open: OpenUrl; copy: CopyText;
  now: () => number; sleep: Sleep; timeZone: string | undefined }

// A new worker session: what `aures login` and «войти заново» on the screen do. The session
// goes to the worker in doPost login, and the verdict comes back in its reply.
export async function signInAgain(worker: Worker, { fetch, io, files, open, copy, now, sleep, timeZone }: LoggingIn): Promise<number> {
  io.print(chatgptLogin());
  const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io, open, copy) });
  const id = randomUUID();
  io.wait(t('Handing the sign-in to the worker…', 'Передаём вход воркеру…'));
  const reply = await worker.ask('login', { login: { id, session } }).finally(() => io.wait(null));
  const summary = reply.summary as Summary | null;
  const verdict = summary?.login?.id === id ? summary.login.result : null;
  if (verdict === 'rejected') throw new CommandFailed(otherAccount());
  if (verdict !== 'accepted' || !summary) {
    throw new CommandFailed(reply.outcome === 'broken_state' ? brokenOnGoogle(reply.reason) :
      t('The worker did not take the new sign-in.', 'Воркер не принял новый вход.'));
  }
  await files.rememberAccount('chatgpt', sessionEmail(session));
  io.print(renewed());
  io.print(reply.outcome === 'transient_error' ? unavailable() : workingLine(summary, timeZone));
  return 0;
}
