# Installation and use

**English** · [Русский](installation.md)

## Quick install

You need a Mac, a Google or GitHub account (the worker lives there) and a paid ChatGPT subscription with resets.

```sh
brew install keshaqaz/tap/aures
aures setup
```

`setup` goes in stages, one line each; it opens every page itself and goes on by itself once you are done. First pick the platform:

```
  1. GitHub Actions — runs once an hour, but GitHub skips many runs.
  2. Google Apps Script — runs every 5 minutes.
Type 1 or 2:
```

Google is more precise and simpler; its stages follow.

| Stage | What to do |
| --- | --- |
| `[1/4] Platform` | Type `2`. |
| `[2/4] Signing in to Google` | Pick the account → «Continue» → «Continue» → «Select all» → «Continue». |
| `[3/4] The worker on Google` | If asked: on the page that opens, click the «Google Apps Script API» switch. Then on the «aures-worker (Unverified)» page: «Review permissions» → the same account → «Advanced» → «Go to aures-worker (unsafe)» → «Select all» → «Continue». |
| `[4/4] Signing in to ChatGPT` | The code is already on the clipboard: paste it on the page that opens and sign in to the account with the resets. |

It ends with `Done. Resets: N.`, and the main aures screen opens.

Both Google «unverified app» warnings are expected: the aures app and the worker script are yours, Google just has not reviewed them. If a stage waits longer than ~30 seconds, `setup` prints a hint with the buttons and a link in case the browser did not open. If `setup` is interrupted, just run it again — it picks up where it stopped.

### On GitHub

| Stage | What to do |
| --- | --- |
| `[1/5] Platform` | Type `1`. |
| `[2/5] Signing in to GitHub` | The code is already on the clipboard: paste it on the page that opens and allow access. |
| `[3/5] The worker repository` | Nothing: a private `codex-auto-resets-worker` repository appears in your account. |
| `[4/5] Signing in to ChatGPT` | As on Google. Then pick the rules (Enter keeps them). If you turn on «When the weekly limit runs out», `setup` asks for one more ChatGPT code — for this Mac (see [The Mac check](#the-mac-check)). |
| `[5/5] The worker on GitHub` | Nothing: the schedule and a trial run. |

### From source

Node 26 required:

```sh
git clone https://github.com/Keshaqaz/aures.git && cd aures
npm ci && npm run build:worker
echo "alias aures='node $PWD/src/cli/main.ts'" >> ~/.zshrc && source ~/.zshrc
```

### Language

The CLI speaks your system's language. To change it: `aures language en` / `aures language ru` or `l` on the screen.

## Every day

```sh
aures
```

<img src="assets/status-en.png" alt="The aures screen: resets on top, rules below, the worker line">

Resets with their deadlines on top, the rules below, then a line about the worker.

- `↑` `↓` — pick a line.
- `Enter` on a reset — apply it now (`y` to confirm). A reset is single-use; applying it cannot be undone.
- `Enter` on a rule — turn it on or off.
- `Tab` — the «Worker» screen.
- `l` — language, `r` — refresh, `q` — quit.

If something is wrong, a line with `!` and a hint appears at the bottom. `aures status` prints the same once.

## Rules

| Rule | Default | What it does |
| --- | --- | --- |
| Before expiry | on | Applies a reset in its last hour on Google, in its last 8 hours on GitHub. |
| When the weekly limit runs out | on for Google, off for GitHub | As soon as the weekly limit has run out, applies the reset with the nearest deadline. |

The rules cover every reset and take effect from the worker's next run. Change them on the `aures` screen or with `aures rules`.

## The «Worker» screen

<img src="assets/worker-en.png" alt="The «Worker» screen: platform, accounts, actions and journal">

`Tab` opens and closes it. It has:

- **Worker** — the platform, its state and a link to the repository or project.
- **Accounts** — GitHub or Google, and ChatGPT; each with «sign in again».
- **Actions:**
  - «Check now» — a trial run: the worker reads the resets and says what the rules would do, spending nothing.
  - «Repair» — redeploy the current worker and bring its schedule back. Resets, rules and the sign-in are kept.
  - «Pause» / «Unpause» — take the schedule off or bring it back. While paused the rules do not run and resets expire on their deadline; «Apply now» still works.
  - «Switch to …» — move the worker to the other platform (below).
- **Journal** — the worker's recent runs: when, why, and how each ended. Updates itself while the screen is open.

### Switching platforms

«Switch to …» prepares the new worker while the old one keeps running (sign-ins to the new platform and to ChatGPT, as at install), then retires the old one and turns the new one on. `Esc` before the retirement cancels everything. If the switch is interrupted, the screen has one action left — «Retry the switch». If the worker has an application with an unknown outcome, the switch waits for its next run so it never spends a second reset.

## The Mac check

Only for GitHub with the weekly rule on. GitHub runs the worker imprecisely, so the Mac notices the end of the weekly limit: a launchd agent reads the limit every 2 minutes (this spends nothing) and, once it has run out, starts the worker. The worker itself applies the reset. Works while the Mac is awake; the log is `~/Library/Logs/codex-auto-resets/watch.log`.

On Google the check is not needed: the worker looks at the limit itself every 5 minutes, even with the Mac off.

<details>
<summary>watch.log lines</summary>

| Line | Meaning |
| --- | --- |
| `idle`, `quiet` | The limit has not run out, or the worker was already started for this window. |
| `dispatched`, `dispatched (2 of 3)` | The limit ran out, the worker was started (again, if the limit did not renew). |
| `no_resets` | The limit ran out, but there are no resets. |
| `paused`, `switching` | The worker is paused, or a platform switch is unfinished. |
| `transient_error: …` | ChatGPT did not answer for now; the next pass retries. |
| `reauth_required…`, `no_session` | The Mac has no ChatGPT sign-in: `aures setup`. |
| `no_github_token`, `github_error: …`, `no_worker`, … | A problem with the GitHub sign-in or the repository: see `aures status`. |

</details>

## When something breaks

When the worker fails, the platform sends an email. Run `aures status` — it tells the cause and what to do.

| Message | What to do |
| --- | --- |
| The worker lost its ChatGPT sign-in | `aures login` |
| The worker is outdated | `aures upgrade` |
| Setup is not finished; the worker on Google does not answer | `aures setup` |
| The worker has no schedule | «Repair» on the «Worker» screen |
| The worker is disabled in GitHub | Follow the link in the message — **Enable workflow** |
| The worker / GitHub / Google has not run the worker for N h | Check Actions or the script's executions via the link in the message |
| The worker script was not given every access | `aures setup` opens the consent again: tick both boxes |
| This is another ChatGPT account | Sign in to the account the worker was set up for, or reinstall: `uninstall`, then `setup` |
| This Mac's ChatGPT sign-in is lost | `aures setup` |

## Upgrade

```sh
brew upgrade aures
aures upgrade
```

`aures upgrade` updates the worker itself; rules, journal and the ChatGPT sign-in are kept. On Google it may ask for the Google sign-in again (it lasts 7 days) — the same buttons as at install. From source: `git pull && npm ci && npm run build:worker`, then `aures upgrade`.

From a version before 0.3.0 (`codex-auto-resets`), upgrade once by the full name: `brew update && brew upgrade keshaqaz/tap/aures && aures upgrade`.

## Uninstall

```sh
aures uninstall
brew uninstall aures
```

`uninstall` asks to confirm, stops the worker, revokes its ChatGPT sign-in and removes everything aures keeps on this Mac.

- **GitHub:** asks you to sign in to GitHub once more to delete the repository. At the end follow the link and click **Revoke**.
- **Google:** the aures Google sign-in is revoked for the whole account, so on another Mac the next `upgrade` asks to sign in again. The CLI cannot delete the script project — it ends with a link: move `aures-worker` to the trash on script.google.com (or leave it: it no longer does anything).

## What is stored where

| Where | What |
| --- | --- |
| Mac Keychain (service `codex-auto-resets`) | the GitHub sign-in; on Google, the Google sign-in and the worker secret |
| `codex-auto-resets-worker` repository (GitHub) | the worker, schedule, rules, a summary of resets and the worker's encrypted ChatGPT sign-in |
| `aures-worker` project (Google) | the worker, schedule, rules, journal and the worker's ChatGPT sign-in (in Script Properties) |
| `~/Library/Application Support/codex-auto-resets/` | the platform and worker address, the language pick; for the Mac check, its ChatGPT sign-in and state |
| `~/Library/LaunchAgents/com.github.keshaqaz.codex-auto-resets.watch.plist` | the Mac check agent |

The worker repository must stay private. The worker's web app on Google answers only requests carrying the secret from your Mac's Keychain and never returns tokens. More on security — [ADR-0005](adr/0005-weekly-check-from-mac.md) and [ADR-0007](adr/0007-two-worker-platforms.md).

## What it costs

Nothing. GitHub: up to ~750 Actions minutes a month of the free 2000. Google: 5–10 trigger minutes a day of 90. If you run other Actions or scripts, count the total.
