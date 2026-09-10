# Headroom provider extension

This project-local Pi extension routes the native `github-copilot` and `openai-codex` providers through a local Headroom proxy.

For Headroom installation, configuration, and usage, read the [official Headroom repository](https://github.com/headroomlabs-ai/headroom).

## Install Headroom

This extension needs Headroom's Python CLI. The npm package is an SDK and does not install the `headroom` command.

On macOS or Linux, install the pinned proxy package with [uv](https://docs.astral.sh/uv/):

```bash
brew install uv  # skip if uv is already installed
uv tool install --python 3.13 "headroom-ai[proxy]==0.37.0"
uv tool update-shell
headroom --version
```

Use the approved Headroom release for your environment instead of `0.37.0` when necessary. The CLI also works with `pipx`:

```bash
pipx install --python python3.13 "headroom-ai[proxy]==0.37.0"
```

## Start Headroom

Run the proxy in a separate terminal and leave it running while Pi is in use:

```bash
HEADROOM_BEACON=off DO_NOT_TRACK=1 \
HEADROOM_SAVINGS_PROFILE=coding \
  headroom proxy --host 127.0.0.1 --port 8787
```

Check both endpoints before sending a request:

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/readyz
```

A request is proxied only when `/readyz` returns 2xx JSON containing `{"ready": true}`. The extension probes before every request and falls back to the native provider when Headroom is unavailable.

## Configure Pi

1. Keep this directory at `.pi/extensions/provider-headroom/`.
2. Reload or restart Pi after adding the extension.
3. Authenticate GitHub Copilot and OpenAI Codex through Pi's normal native provider flows.
4. Use the native `github-copilot` or `openai-codex` provider. Do not change `auth.json`, `models.json`, the provider base URL, or add `x-headroom-base-url` yourself.

When Headroom is ready, Copilot requests use `http://127.0.0.1:8787/v1` and carry their resolved upstream URL in the internal routing header. Codex keeps its native account and authorization headers. A failed proxied request is returned as-is and is not replayed directly.

For a Copilot Enterprise or other private upstream, allow its host in Headroom before starting the proxy:

```bash
HEADROOM_ALLOWED_BASE_URLS=ghe.example.com \
HEADROOM_BEACON=off DO_NOT_TRACK=1 \
HEADROOM_SAVINGS_PROFILE=coding \
  headroom proxy --host 127.0.0.1 --port 8787
```

Use Headroom's networking and security guidance for the correct allowlist value.

Subagents launched with `--no-extensions` keep their normal direct provider routes.

## Rollback

Remove `.pi/extensions/provider-headroom/`, then reload or restart Pi. No global configuration needs to be restored.
