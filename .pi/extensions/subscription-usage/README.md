# Subscription & Cloud Usage for Pi

A minimal extension that shows your usage limits in one place through `/usage`:

- **ChatGPT Codex** — plan and weekly rate-limit usage from the authenticated request behind Codex's own `/status` card: a single `GET /backend-api/wham/usage` (the same endpoint Codex's `BackendClient` uses), rendered as **Plan, Weekly limit (+ reset time), and rate-limit reset credits**.
- **Ollama Cloud** — session and weekly usage from `GET https://ollama.com/api/usage` (the endpoint behind the Ollama web UI's usage card), signed with the Ed25519 key the Ollama app keeps at `~/.ollama/id_ed25519`, rendered as **Session usage and Weekly usage** rows.

## Step 1: authentication

Each provider uses its existing local credential; nothing is printed, cached, copied to Keychain, or persisted.

**Codex** reads `$CODEX_HOME/auth.json` (or `~/.codex/auth.json`) and extracts only the ChatGPT access token and account ID. If authentication is missing, invalid, expired, or rejected, run:

```bash
codex login
```

**Ollama** reads `~/.ollama/id_ed25519` (no environment override exists in the Ollama source), parses the unencrypted `openssh-key-v1` blob, and signs the challenge `GET,/api/usage?ts=<unix-seconds>` with `crypto.subtle`, sending `Authorization: Bearer <base64(ssh-ed25519 wire pubkey)>:<base64(signature)>` (a bare header is retried if Bearer is rejected). If the key is missing or rejected, sign in to the Ollama app (which creates the key) and link it at https://ollama.com/connect.

Run:

```text
/usage auth status            # inspect both credential files (no network)
/usage codex auth status      # Codex only
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

Plain `/usage` shows both, one block per provider; a failing provider is reported inline instead of hiding the healthy one:

```text
ChatGPT Codex · Plan: Pro
Weekly limit: 58% used · resets 14:30 on 24 Aug
Rate-limit reset credits: 1 available

Ollama Cloud
Session usage: 16% used
Weekly usage: 3% used
```

- Codex semantics mirror Codex's own display: the weekly window is the one Codex labels `weekly` (primary or secondary), falling back to the secondary window; reset times use `HH:MM` today, otherwise `HH:MM on %-d %b`; plan names are remapped like Codex's status card (Team → Business, Business → Enterprise, Pro Lite, Enterprise (Automation)).
- Ollama semantics mirror the live `/api/usage` contract: `limits.session.usage` / `limits.weekly.usage` are fractions of the window limit (`0.162` → `16%`); the `session_usage`/`weekly_usage` shape proposed in ollama/ollama#16448 is still accepted defensively.
- A snapshot older than 15 minutes is marked `(stale)`; rows are omitted when absent.

The `subscription_usage` and `ollama_usage` tools expose the same data to the agent; each `status` reuses its latest in-memory snapshot when fresh, `refresh` queries the provider. No raw response, account ID, user ID, email, cookie, access token, key material, or signature is persisted or returned.

## Scope

Kept: Codex plan/weekly limit/reset credits, Ollama session/weekly usage, 15-minute staleness, per-provider caches, cache-or-refresh, Bearer→bare auth fallback.

Dropped: daily-token/workspace/skill/plugin analytics, credit events, 30-day history, spend control, Ollama activity cost/period and per-model breakdowns, reset timestamps for Ollama, plan upgrades.
