# Ollama Cloud Usage for Pi

A minimal extension that shows the Ollama Cloud **session and weekly usage** through `/ollama-usage`. It signs a single request against `GET https://ollama.com/api/usage` — the same endpoint behind the Ollama web UI's usage card — using the Ed25519 key the Ollama app itself uses, and renders the result as compact usage rows.

## Step 1: authentication

The extension signs requests with the same Ed25519 identity the Ollama app uses, read directly from:

- `~/.ollama/id_ed25519` (no environment override exists in the Ollama source; the path is fixed relative to the home directory).

The key is the unencrypted `openssh-key-v1` blob that `ssh-keygen -t ed25519` writes. The extension parses it in-process, wraps the seed in its PKCS8 envelope for `crypto.subtle`, and signs the challenge `GET,/api/usage?ts=<unix-seconds>` exactly like the app's `doSelfSigned` (app/ui/ui.go) and cloud proxy (`server/cloud_proxy.go`): `Authorization: Bearer <base64(ssh-ed25519 wire pubkey)>:<base64(signature)>` (a bare header is retried if Bearer is rejected). It does not print, cache, copy to Keychain, or persist the key.

Run:

```text
/ollama-usage auth status
```

The command inspects the key file only (no network): missing, unreadable, and unparseable keys are reported with next steps. Live validation happens when `/ollama-usage` actually fetches. If the key is missing or rejected, sign in to the Ollama app (which creates `~/.ollama/id_ed25519`) and link the key at https://ollama.com/connect.

## Usage

```text
/ollama-usage               # show the cached usage if fresh (<15 min), else fetch and show
/ollama-usage refresh       # always fetch from ollama.com and show
/ollama-usage probe         # single-endpoint contract check (diagnostic if the contract drifts)
/ollama-usage auth status   # inspect the Ollama key file (no network)
```

The output is compact:

```text
Ollama Cloud
Session usage: 16% used
Weekly usage: 3% used
```

- The live contract (`limits.session.usage` / `limits.weekly.usage`) reports usage as a fraction of the window limit (`0.162` → `16%`), so the rows mirror that semantics. A snapshot older than 15 minutes is marked `(stale)`.
- The response's `activity` block (cost, period) and per-model request counts are deliberately not rendered.
- The `session_usage`/`weekly_usage` shape proposed in ollama/ollama#16448 (with `percentage` and `resets_in`) is still accepted defensively and renders the same rows.
- Rows are omitted when absent; a `plan` field renders `Ollama Cloud · Plan: <plan>` when present.

The `ollama_usage` tool exposes the same usage to the agent. `status` reuses the latest in-memory snapshot when it is fresh; `refresh` queries ollama.com. No raw response, key material, signature, or user data is persisted or returned.

## Scope

Kept: session + weekly usage rows, 15-minute staleness, cache-or-refresh, Bearer→bare auth fallback.

Dropped: activity cost/period, per-model breakdowns, model recommendations, reset timestamps, plan upgrades.
