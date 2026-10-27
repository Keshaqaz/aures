# Installation and use

**English** · [Русский](installation.md)

## Quick install

You need a Mac, a Google account (the worker lives there) and a paid ChatGPT subscription with resets.

```sh
brew install keshaqaz/tap/aures
aures setup
```

`setup` goes in stages, one line each; it opens every page itself and goes on by itself once you are done.

| Stage | What to do |
| --- | --- |
| `[1/4] Signing in to Google` | Pick the account. On the «Google hasn't verified this app» page: «Advanced» → «Go to aures (unsafe)». Then «Continue» → «Select all» → «Continue». |
| `[2/4] The worker on Google` | If asked: on the page that opens, click the «Google Apps Script API» switch. Then on the «aures-worker (Unverified)» page: «Review permissions» → the same account → «Advanced» → «Go to aures-worker (unsafe)» → «Select all» → «Continue». |
| `[3/4] Signing in to ChatGPT` | The code is already on the clipboard: paste it on the page that opens and sign in to the account with the resets. |
| `[4/4] First run` | Nothing: the schedule and a trial check. |

Each stage has a line on why it is there, its steps get a `✓`, and what you need to do is a `→` line. It ends with `Done. Resets: N.`, and the main aures screen opens.

<img src="assets/setup-en.png" alt="aures setup: four stages with their reasons and ticks, Done and the screen opening">

Both Google «unverified app» warnings are expected: the aures app and the worker script are yours, Google just has not reviewed them. If a stage waits longer than ~30 seconds, `setup` prints a hint with the buttons and a link in case the browser did not open. If `setup` is interrupted, just run it again — it picks up where it stopped.

### From source

Node 26 required:

```sh
git clone https://github.com/Keshaqaz/aures.git && cd aures
npm ci && npm run build:worker
echo "alias aures='node $PWD/src/cli/main.ts'" >> ~/.zshrc && source ~/.zshrc
```

### Language

The CLI speaks your system's language. To change it: `aures language en` / `aures language ru` or `l` on the screen.

### Had a worker on GitHub

Before 0.6.0 the worker could also run on GitHub Actions. Now it lives on Google Apps Script only ([ADR-0009](adr/0009-google-only-worker.md)), and aures cannot move it.

1. Delete the private `codex-auto-resets-worker` repository on GitHub: Settings → Danger Zone → Delete this repository. While it is there, its schedule keeps running the worker.
2. If you like, take back aures' access to GitHub: GitHub → Settings → Applications → Authorized OAuth Apps → Revoke.
3. Run `aures setup` — it installs the worker on Google from scratch. Choose the rules again on the `aures` screen.

The agent of the Mac check of an earlier version removes itself the first time it runs after the upgrade; `aures upgrade` and `aures uninstall` remove it too. `aures uninstall` removes the GitHub sign-in from the Keychain.

## Every day

```sh
aures
```

<img src="assets/status-en.png" alt="The aures screen: resets on top, rules below, the worker section">

Resets with their deadlines on top, the rules below, then the worker: its state on the right, the next run and the last application.

The line under the header fills up from the last scheduled run to the next one. Full and with no new run, it stays full until the worker runs. On pause the whole line is dashed.

- `↑` `↓` — pick a line.
- `Enter` on a reset — apply it now (`y` to confirm). A reset is single-use; applying it cannot be undone.
- `Enter` on a rule — turn it on or off.
- `Tab` — the «Worker» screen.
- `l` — language, `r` — refresh, `q` — quit.

If something is wrong, a line with `!` and a hint appears at the bottom. `aures status` prints the same once.

## Rules

| Rule | Default | What it does |
| --- | --- | --- |
| Before expiry | on | Applies a reset in its last hour. |
| When the weekly limit runs out | on | As soon as the weekly limit has run out, applies the reset with the nearest deadline. The worker checks the limit every 5 minutes, even with the Mac off. |

The rules cover every reset and take effect from the worker's next run. Change them on the `aures` screen or with `aures rules`.

## The «Worker» screen

<img src="assets/worker-en.png" alt="The «Worker» screen: the worker, accounts, actions and journal">

`Tab` opens and closes it. It has:

- **Worker** — its state on the right and a link to the script project. On pause the bracket of the section is dashed.
- **Accounts** — Google and ChatGPT; each with «sign in again».
- **Actions:**
  - «Check now» — a trial run: the worker reads the resets and says what the rules would do, spending nothing.
  - «Repair» — redeploy the current worker and bring its schedule back. Resets, rules and the sign-in are kept.
  - «Pause» / «Unpause» — take the schedule off or bring it back. While paused the rules do not run and resets expire on their deadline; «Apply now» still works.

  Hold the cursor on an action for about half a second and its caption opens under the row; it stays open as you move along the row and closes when you leave it.
- **Journal** — the worker's recent runs, newest first, in three columns: when, who started it (`schedule` or `you` — a check, a sign-in, «Apply now», an action on this screen) and what came of it. Quiet runs in a row fold into one line, such as «7 checks — all fine, nothing to apply». On the right of its heading — when it was read and how long the worker took to answer, or «no answer» in yellow. While the screen is open the journal is polled every 30 seconds. `↓` from the actions moves into the journal; its bracket is the scroll bar.

While the screen reads the worker, a runner goes down the journal's bracket: a quick answer is a quick run, a slow one crawls, and a yellow stop means no answer. While an action runs, the bracket of its section fills up — for a sign-in or «Apply now», whose time is unknown, a runner goes round it instead — then lights green when it is done, or yellow if it needs a look. With `AURES_MOTION=off` or `NO_COLOR` set, nothing moves.

## When something breaks

When the worker fails, Google sends an email about the failed trigger. Run `aures status` — it tells the cause and what to do.

| Message | What to do |
| --- | --- |
| The worker lost its ChatGPT sign-in | `aures login` |
| Setup is not finished; the worker on Google does not answer | `aures setup` |
| The worker has no schedule | «Repair» on the «Worker» screen |
| Google has not run the worker on schedule for N h | Check the script's executions via the link in the message |
| The worker script was not given every access | `aures setup` opens the consent again: tick both boxes |
| This is another ChatGPT account | Sign in to the account the worker was set up for, or reinstall: `uninstall`, then `setup` |

## Upgrade

```sh
brew upgrade aures
aures upgrade
```

`aures upgrade` updates the worker itself; the rules, the journal and the ChatGPT sign-in are kept. It may ask for the Google sign-in again if it was revoked — the same buttons as at install. From source: `git pull && npm ci && npm run build:worker`, then `aures upgrade`.

From a version before 0.3.0 (`codex-auto-resets`), upgrade once by the full name: `brew update && brew upgrade keshaqaz/tap/aures && aures upgrade`.

## Uninstall

```sh
aures uninstall
brew uninstall aures
```

`uninstall` asks for confirmation, stops the worker, revokes its ChatGPT sign-in and removes everything of aures on this Mac. The aures sign-in to Google is revoked for the whole account, so on another Mac the next `upgrade` asks you to sign in again. The CLI cannot delete the script project — there will be a link at the end: move `aures-worker` to the trash on script.google.com (or leave it: it no longer does anything).

## What is stored where

| Where | What |
| --- | --- |
| The Mac's Keychain (service `codex-auto-resets`) | the Google sign-in and the worker secret |
| The `aures-worker` project (Google) | the worker, the schedule, the rules, the journal and the worker's ChatGPT sign-in (in Script Properties) |
| `~/Library/Application Support/codex-auto-resets/` | the worker's address, the accounts, the language choice |

The worker's web app answers only requests with the secret from your Mac's Keychain and never returns tokens. More on security — [ADR-0007](adr/0007-two-worker-platforms.md).

## What it costs

Nothing: 5–10 trigger-minutes a day out of the free 90. If you have other Apps Script projects, count the total.
