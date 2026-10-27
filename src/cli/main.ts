#!/usr/bin/env node
// `aures <command>`.
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { setup } from './setup.ts';
import { status } from './status.ts';
import { screen } from './screen.ts';
import { applyNow } from './apply-now.ts';
import { rules } from './rules.ts';
import { login } from './login.ts';
import { upgrade } from './upgrade.ts';
import { uninstall } from './uninstall.ts';
import { MacFiles } from './mac-files.ts';
import { LaunchAgent, removeCheckLeftovers } from './launch-agent.ts';
import { KeychainEntry, GOOGLE_TOKEN_ACCOUNT, WORKER_SECRET_ACCOUNT } from './keychain.ts';
import { openInBrowser, copyToClipboard } from './browser.ts';
import { liveLine } from './live-line.ts';
import type { CommandOptions } from './common.ts';
import { t, setLanguage, startLanguage, readSystemLanguage, isLanguage } from './language.ts';
import pkg from '../../package.json' with { type: 'json' };

// The worker bundle that setup and upgrade deploy: `npm run build:worker`.
const APPS_SCRIPT_BUNDLE = new URL('../../dist/apps-script/worker.js', import.meta.url);
type Command = (options: CommandOptions) => Promise<number>;
interface Bundle { appsScriptSource: string }
// null when the bundle is not built.
const readBundle = (): Promise<string | null> => readFile(APPS_SCRIPT_BUNDLE, 'utf8').catch(() => null);
// Without the bundle setup and upgrade do not start.
const withBundle = (command: (options: CommandOptions & Bundle) => Promise<number>): Command => async options => {
  const appsScriptSource = await readBundle();
  if (appsScriptSource == null) {
    console.error(t('There is no worker build in dist/. Build it: npm run build:worker',
      'Нет сборки воркера в dist/. Соберите её: npm run build:worker'));
    return 1;
  }
  return command({ ...options, appsScriptSource });
};
// The Keychain entries, the browser and the clipboard every command gets.
const access = () => ({ googleKeychain: new KeychainEntry(GOOGLE_TOKEN_ACCOUNT),
  secretKeychain: new KeychainEntry(WORKER_SECRET_ACCOUNT), open: openInBrowser, copy: copyToClipboard });
// The agent left by the check from this Mac runs `watch` every 2 minutes; `watch` removes it
// (ADR-0009). It is not in the usage and prints nothing.
const usage = (): string => t(`Usage: aures [command]
  (no command)   the screen: resets and rules; Enter applies a reset or switches a rule;
                 Tab — the screen «Worker»: check now, repair, pause, the journal
  status         the same printed once, without controls
  setup          install, or finish an interrupted install
  apply-now      apply a reset now
  rules          choose when resets are applied
  login          sign the worker in to ChatGPT again
  upgrade        update the worker after brew upgrade
  uninstall      remove the worker and the sign-ins
  language       en or ru: the language of the CLI
  --version      the program version`, `Использование: aures [команда]
  (без команды)  экран: сбросы и правила; Enter применяет сброс или переключает правило;
                 Tab — экран «Воркер»: проверить сейчас, починить, пауза, журнал
  status         то же одним выводом, без управления
  setup          установить или продолжить установку
  apply-now      применить сброс сейчас
  rules          когда применять сбросы
  login          заново войти в ChatGPT
  upgrade        обновить воркер после brew upgrade
  uninstall      удалить воркер и входы
  language       en или ru: язык программы
  --version      версия программы`);

async function main(): Promise<number> {
  const [name, ...rest] = process.argv.slice(2);
  if (name === '--version' && !rest.length) {
    console.log(pkg.version);
    return 0;
  }
  const files = new MacFiles();
  // The pick in settings.json wins; without one the language follows the system, and only
  // the pick is written — by `aures language` below or `l` on the screen.
  setLanguage(startLanguage(await files.readLanguage(), await readSystemLanguage()));
  const [choice] = rest;
  if (name === 'language' && rest.length === 1 && isLanguage(choice)) {
    setLanguage(choice);
    await files.writeLanguage(choice);
    console.log(t('The CLI speaks English.', 'Программа говорит по-русски.'));
    return 0;
  }
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  // The screen, opened by `aures` without a command — and after a setup that succeeded in a
  // terminal (issue 30). setup only hands the wish over (openScreen below); the screen itself
  // opens once the command's readline is closed, so that while it runs, stdin has one reader.
  const openMainScreen = async (): Promise<number> => {
    // A question before the screen opens (where the worker is) gets a line of its own.
    const prompt = async (question: string) => {
      const line = createInterface({ input: process.stdin, output: process.stdout });
      try { return await line.question(question); } finally { line.close(); }
    };
    const io = { print: (line: string) => console.log(line), prompt, color };
    // «Починить» on the screen «Воркер» deploys the bundle; without it it says so.
    const appsScriptSource = await readBundle();
    // An action that Ctrl-C left unfinished must not keep the process alive.
    process.exit(await screen({ fetch: globalThis.fetch, ...access(), io, appsScriptSource,
      mac: { files, agent: new LaunchAgent() }, terminal: { input: process.stdin, output: process.stdout } }));
  };
  // What a successful setup in a terminal asks for: the screen, opened by main once the
  // command is over — not inside it, with the readline of the command still on stdin.
  let screenAfterSetup = false;
  const commands: Record<string, Command> = { setup: withBundle(options => setup({ ...options,
      ...(tty ? { openScreen: async () => { screenAfterSetup = true; return 0; } } : {}) })),
    status, 'apply-now': applyNow, rules, login, upgrade: withBundle(upgrade), uninstall };
  // Outside a terminal the screen is printed once, as `status`.
  const run = name === undefined ? tty ? 'screen' : status : Object.hasOwn(commands, name) ? commands[name] ?? null : name === 'watch' ? 'watch' : null;
  if (!run || rest.length) {
    console.error(usage());
    return 2;
  }
  if (process.platform !== 'darwin') {
    console.error(t('aures runs on macOS only.', 'aures работает только на macOS.'));
    return 1;
  }
  if (run === 'watch') {
    // Silent, code 0: only the leftovers of the check from this Mac go (ADR-0009).
    await removeCheckLeftovers({ files, agent: new LaunchAgent() });
    return 0;
  }
  if (run === 'screen') return await openMainScreen();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const { print, wait } = liveLine(process.stdout, { color });
  const io = { print, wait, prompt: (question: string) => terminal.question(question), color };
  let code: number;
  try {
    code = await run({ fetch: globalThis.fetch, ...access(), io, mac: { files, agent: new LaunchAgent() } });
  } finally { terminal.close(); }
  // A setup that succeeded in a terminal opens the screen (issue 30) — here and only here,
  // with the command's readline closed and its live line gone, so the screen owns stdin alone.
  if (screenAfterSetup) return await openMainScreen();
  return code;
}

process.exitCode = await main();
