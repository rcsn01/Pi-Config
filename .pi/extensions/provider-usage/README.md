# Subscription & Cloud Usage for Pi

A minimal extension that shows your usage limits in one place through `/usage`:

- **ChatGPT Codex** — plan and rate-limit usage from the authenticated request behind Codex's own `/status` card: `GET /backend-api/wham/usage` for each saved account (the same endpoint Codex's `BackendClient` uses), rendered as **Plan, 5-hour session limit, Weekly limit (+ reset times), and rate-limit reset credits**.
- **Ollama Cloud** — session and weekly usage from `GET https://ollama.com/api/usage` (the endpoint behind the Ollama web UI's usage card), signed with the Ed25519 key the Ollama app keeps at `~/.ollama/id_ed25519`, rendered as **Session usage and Weekly usage** rows.

## Step 1: authentication

Each provider uses its existing local credential. Pi Codex request headers are exposed only to the in-memory usage callback; normalized usage snapshots are cached by an opaque account hash. Tokens, account IDs, headers, response bodies, and key material are never rendered or stored by this extension.

**Codex** uses Pi's `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`) and the named slots managed by `provider-codex`. `/usage codex` resolves every saved slot with Pi's native `openai-codex` OAuth provider, including refresh and rotated-token writeback, without switching the active slot. Empty, invalid, expired, and failed slots remain visible with a safe per-slot message. Select a slot and sign in with:

```text
/codex use <name>
/login openai-codex
```

**Ollama** reads `~/.ollama/id_ed25519` (no environment override exists in the Ollama source), parses the unencrypted `openssh-key-v1` blob, and signs the challenge `GET,/api/usage?ts=<unix-seconds>` with `crypto.subtle`, sending `Authorization: Bearer <base64(ssh-ed25519 wire pubkey)>:<base64(signature)>` (a bare header is retried if Bearer is rejected). If the key is missing or rejected, sign in to the Ollama app (which creates the key) and link it at https://ollama.com/connect.

Run:

```text
/usage auth status            # list Pi Codex slots and inspect Ollama auth (no network)
/usage codex auth status      # list Codex slots only
/usage ollama auth status     # Ollama only
```

## Usage

```text
/usage               # show both providers (cached if fresh (<15 min), else fetch)
/usage refresh       # always fetch both from their providers
/usage probe         # single-endpoint contract check for both (diagnostic if contracts drift)
/usage auth status   # inspect both credential files (no network)
/usage codex [...]   # limit any action to ChatGPT Codex
/usage ollama [...]  # limit any action to Ollama Cloud
```

Plain `/usage` shows every Codex slot and the Ollama block; a failing slot or provider is reported inline instead of hiding healthy results:

```text
ChatGPT Codex · Slot: default (active) · Plan: Pro
5-hour session limit: [███░░░░░░░░░░░░░░░░░] 16% used · resets in 5h on 17 Aug
Weekly limit: [████████████░░░░░░░░] 58% used · resets in 7d 4h on 24 Aug
Rate-limit reset credits: 1 available

ChatGPT Codex · Slot: work
This Codex credential could not be refreshed. Select the slot with `/codex use <name>` and run `/login openai-codex`.

Ollama Cloud
Session usage: [███░░░░░░░░░░░░░░░░░] 16% used · resets in 40m on 17 Aug
Weekly usage: [█░░░░░░░░░░░░░░░░░░░] 3% used · resets in 6d 12h on 24 Aug
```

Usage bars use 20 boxes (5% each): solid boxes (`█`) for the filled share
and light-shade boxes (`░`) for the empty track. Every reset label follows
the same `resets in X on <date>` style (`countdown.ts`): compact web-UI-style
countdowns (`40m`, `2h 45m`, `6d 12h`) plus the reset date (`24 Aug`), with
the instants coming from Codex's `resetsAt` and the computed Ollama
boundaries (next full hour / next week boundary from the API anchor). At the
notify boundary the output stays plain text for portable TUI, RPC, print, and
JSON consumers. Usage data is available only through the user-run `/usage`
command, not as an LLM-facing tool. `stripAnsi()` in `style.ts` remains
available for legacy text.

- Codex semantics mirror Codex's own display: the 5-hour session window is the one labeled `5h` (primary, then secondary); the weekly window is the one Codex labels `weekly` (primary or secondary), falling back to the secondary window; reset times use `HH:MM` today, otherwise `HH:MM on %-d %b`; plan names are remapped like Codex's status card (Team → Business, Business → Enterprise, Pro Lite, Enterprise (Automation)).
- Ollama semantics mirror the live `/api/usage` contract: `limits.session.usage` / `limits.weekly.usage` are fractions of the window limit (`0.162` → `16%`); the `session_usage`/`weekly_usage` shape proposed in ollama/ollama#16448 is still accepted defensively. The endpoint exposes no reset timestamps, so the countdowns are derived from real anchors where possible: the **weekly** countdown is computed relative to the API's own week boundary — `activity.period.starting_at` (Monday 00:00 UTC in practice), with boundaries repeating every 7 days from that instant — falling back to local Monday 00:00 when the anchor is absent. The **session** countdown mirrors the web UI's observed full-hour alignment (40 minutes at twenty past the hour) and is computed at render time. A proposal-shape `resets_in` value wins when present.
- A snapshot older than 15 minutes is marked `(stale)`; a missing usage window is shown as unavailable.
- Codex usage is cached per account for 15 minutes. Duplicate slots for one account share a request but render as separate named blocks. `refresh` refreshes and updates the cache; diagnostic `probe` bypasses and does not update it.

The extension does not register agent-callable tools. Only the user-run `/usage` command can request subscription data. No raw response, account ID, user ID, email, cookie, access token, key material, or signature is persisted or returned.

## Scope

Kept: every Pi Codex slot's plan/5-hour session limit/weekly limit/reset credits, Ollama session/weekly usage, 15-minute staleness, per-account Codex and Ollama caches, cache-or-refresh, duplicate-account coalescing, and Ollama's Bearer→bare auth fallback.

Dropped: daily-token/workspace/skill/plugin analytics, credit events, 30-day history, spend control, Ollama activity cost/period and per-model breakdowns, exact Ollama reset timestamps (not exposed by the API), plan upgrades.
