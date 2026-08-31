# Pi-Config

Shared configuration for [pi](https://github.com/earendil-works/pi) — the coding agent. This repo holds one `.pi` directory containing extensions (custom tools, UI extensions, workflows) and settings, which other projects link to so they all share the same setup.

## Setup

Install the dependencies used by the extensions:

```bash
cd .pi
pnpm install
```

Verify everything works with:

```bash
pnpm typecheck
pnpm test
```

## Codex credential slots

The `provider-codex` extension adds named slots for OpenAI Codex OAuth credentials while leaving Pi's canonical `openai-codex` provider unchanged. The active slot is shared by every Pi process that uses the same agent directory.

To sign in to a second account:

```text
/codex new work
/login openai-codex
/codex use default
```

`/codex new work` saves the current credential in `default`, creates an empty `work` slot, and makes it active. Run Pi's normal `/login openai-codex` while that slot is active. The next switch saves that login in `work`.

Commands:

- `/codex` opens the slot picker.
- `/codex list` shows active, saved, and empty slots.
- `/codex use <name>` switches to a saved or empty slot.
- `/codex new <name>` creates and activates an empty slot.
- `/codex remove <name>` removes an inactive slot. Removing a saved credential asks for confirmation.

Credentials live in `~/.pi/agent/auth.json`, or in `$PI_CODING_AGENT_DIR/auth.json` when that variable is set. The active OAuth credential remains under `openai-codex`; inactive credentials use extension-owned IDs and the slot state contains only names and IDs. The file is written with mode `0600`. Back it up before using the extension because it contains refresh tokens, and remember that a slot switch changes the credential seen by all Pi processes sharing that agent directory.

The `provider-usage` extension's `/usage codex` command queries every saved Pi Codex slot without switching the active slot. It uses Pi's native OAuth refresh machinery, coalesces duplicate accounts, and renders empty or failed slots separately with safe messages. See `.pi/extensions/provider-usage/README.md` for the usage commands and cache behavior.

## Setting up other projects

Run the setup script and enter the path to each project you want to link:

- macOS/Linux: `./scripts/setup-projects.sh`
- Windows: `.\scripts\setup-projects.ps1`

This links the project's `.pi` directory to this repo's `.pi`, so it picks up the shared configuration.

## Local provider request analysis

Run `/analysis` with no arguments to start capture. The command prints a secret localhost URL. Open it to inspect requests completed after activation, Pi's finalized assistant messages, and normalized provider-reported token and cost fields. Capture works with providers that use Pi's standard request hooks, including Ollama, Ollama Cloud, GitHub Copilot, and OpenRouter. A custom `streamSimple` implementation that skips those hooks cannot be observed. The extension starts no server and retains no payloads until you run the command. Once started, the same URL and in-memory capture survive `/reload`, `/compact`, `/clear`, and other session switches in the same Pi process. Exiting Pi revokes the URL and erases the capture.

The dashboard organizes known payloads as OpenAI Completions, OpenAI Responses, or Anthropic Messages according to the model's API. It shows an unknown API as one generic section containing the complete payload. The page contains complete prompts, tool schemas, tool inputs, results, reasoning state, and raw JSON. Treat its URL as a credential and do not share dashboard contents without checking them for secrets. Pi's provider hook exposes the complete pre-transport logical payload, not headers or later transport transformations.

Usage totals come from Pi's finalized normalized provider usage. For known prefix-cache payload families, section-level cache placement is an estimate based on the aggregate cache count and payload order. Hidden wrappers, tokenizer differences, and cache-boundary rounding prevent exact attribution to individual sections. Unknown API payloads still show usage totals but do not get section-level cache placement.

Capture remains observation-only and keeps complete records in memory under fixed per-record and total limits. Reaching either limit pauses capture rather than truncating a record. The dashboard listens only on localhost and requires the capability token in the generated URL.

## Reasoning-effort prompt-cache diagnostic

Run `/cache-effort-test` to test whether changing reasoning effort preserves OpenAI prompt-cache reuse. The interactive command selects an authenticated OpenAI provider, model, two distinct effort levels, and a run size before showing the exact number of provider calls and asking for confirmation.

The extension makes no provider calls on startup and does not register a tool or modify the active system prompt, tool list, model, or conversation context. Confirmed runs use isolated child Pi RPC sessions with synthetic prompts. OpenAI server caching is measured over SSE; `openai-codex` runs also distinguish Pi's WebSocket continuation cache under `auto`. Results are stored as plain custom session entries, which Pi displays in the transcript but excludes from LLM context.

The balanced run is recommended. It counterbalances `A → A → B → B` and `B → B → A → A`; Codex uses 16 calls because it tests both SSE and `auto`, while direct OpenAI uses 8. Calls may consume subscription quota or incur API charges.

## Temporary GitHub repository explorer

The opt-in `tools-github-repos` extension acquires public `github.com` repositories as immutable source snapshots under `.pi/repos/`. The `github_repo_acquire` tool accepts `owner/repo` or a GitHub HTTPS URL plus an optional branch, tag, full ref, or 40-character commit. It returns the pinned commit and a local source path. Use the normal `read`, `grep`, and `find` tools on that path.

Snapshots persist across Pi sessions. List them with `github_repo_list` or `/repos`. Remove one with `github_repo_remove({ id })` or `/repos remove <id>`. Pi never removes a completed snapshot automatically.

V1 supports public GitHub repositories only. It does not accept credentials, other hosts, SSH or local Git URLs, submodule contents, Git LFS downloads, or full history. Acquisition uses a depth-one fetch, checks tree and disk limits before publication, converts symlinks to regular files containing their targets, removes `.git`, strips executable bits, and marks source files read-only. Repository files remain untrusted data. Do not run their code, builds, tests, package managers, or scripts unless the user separately requests that execution.

When `policy-permissions` is enabled, acquisition counts as network access, removal counts as a mutation, and listing stays read-only. `/repos` has no acquisition form, so network acquisition always goes through the tool permission flow.

## Experimental advisor

The opt-in `tools-advisor` extension lets the executor consult one stronger, read-only model without giving that model tools or edit access.

- `/advisor` opens a TUI picker for the model and thinking level.
- `/advisor on` reuses the saved selection, or opens the picker when no model is configured.
- `/advisor off` disables consultations while retaining the selected model and thinking level.

Enabling advisor adds the `advisor` tool without rewriting the executor's system prompt. Each consultation makes a separate model request with an empty tool list. It receives a bounded copy of the effective conversation, including recent tool calls and results. When the selected model has a smaller context window, the oldest copied context is omitted first. Advice is experimental and remains disabled until configured in the `advisor` namespace of the active settings profile.

## Settings profiles

Complete project settings profiles live at `.pi/profiles/<name>.json`. A profile is a full settings document: switching profiles replaces `.pi/settings.json` rather than merging keys from multiple files.

Use:

- `/profile` to choose a profile interactively.
- `/profile <name>` to switch directly.

To create a profile, copy an existing file in `.pi/profiles`, rename the copy, and edit its settings. Edit the active profile through `.pi/settings.json`; changes made there—including changes from `/model`, `/subagents`, and `/settings`—are automatically written back to the active profile. Inactive profile files may be edited directly.

The `configProfiles.active` field is reserved for the profile extension. It identifies the active profile and is normalized during a switch while other settings and other fields under `configProfiles` are preserved.

Switching writes back the outgoing settings, replaces the complete active document, applies the new profile's saved model selection for the current mode (`uiModelSelector.profiles.normal` or `.plan`) to the current session, and reloads Pi's resources while retaining the current conversation. A plain `/reload` without a profile switch still preserves the session model.

Plan Mode reads its model from `uiModelSelector.profiles.plan` in the active `.pi/settings.json`. Model or thinking-level changes made while Plan Mode is active are saved back to that project setting; no separate global Plan Mode profile is used.
