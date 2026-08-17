# ChatGPT Codex Quota for Pi

A minimal extension that shows the ChatGPT Codex plan and weekly rate-limit usage through `/usage`. It reads the authenticated JSON request behind Codex's own `/status` card: a single `GET /backend-api/wham/usage` (the same endpoint Codex's `BackendClient` uses) rendered as **Plan, Weekly limit (+ reset time), and rate-limit reset credits**.

## Step 1: authentication

The extension reads the existing Codex CLI credential directly from:

- `$CODEX_HOME/auth.json`, when `CODEX_HOME` is set; or
- `~/.codex/auth.json` otherwise.

It extracts only the ChatGPT access token and account ID. It does not print, cache, copy to Keychain, or persist either value.

Run:

```text
/usage auth status
```

The command inspects the auth file only (no network): it checks that the file and required fields exist and detects an expired JWT when possible. Live validation happens when `/usage` actually fetches. If authentication is missing, invalid, expired, or rejected, run:

```bash
codex login
```

## Usage

```text
/usage               # show the cached quota if fresh (<15 min), else fetch and show
/usage refresh       # always fetch from ChatGPT and show
/usage probe         # single-endpoint contract check (diagnostic if the contract drifts)
/usage auth status   # inspect the Codex CLI auth file (no network)
```

The output is compact, mirroring Codex's own display semantics:

```text
ChatGPT Codex · Plan: Pro
Weekly limit: 58% used · resets 14:30 on 24 Aug
Rate-limit reset credits: 1 available
```

- The weekly window is the one Codex labels `weekly` (primary or secondary), falling back to the secondary window; a snapshot older than 15 minutes is marked `(stale)`.
- Reset times use Codex's format: `HH:MM` when the reset falls today, otherwise `HH:MM on %-d %b`.
- Plan names are remapped like Codex's status card (Team → Business, Business → Enterprise, Pro Lite, Enterprise (Automation)).
- Rows are omitted when absent: no window renders `Weekly limit: unavailable`, and no reset-credits field omits the row.

The `subscription_usage` tool exposes the same quota to the agent. `status` reuses the latest in-memory snapshot when it is fresh; `refresh` queries ChatGPT. No raw response, account ID, user ID, email, browser cookie, access token, or refresh token is persisted or returned.

## Scope

Kept: plan, weekly limit + reset time, rate-limit reset credits, 15-minute staleness, cache-or-refresh.

Dropped: daily-token/workspace/skill/plugin analytics, credit events, 30-day history, credits balance, spend control, additional rate limits, and the 5h/daily window rows.
