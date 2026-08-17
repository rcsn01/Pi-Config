# ChatGPT Codex Analytics for Pi

This extension will read the authenticated JSON request behind [ChatGPT Codex Analytics](https://chatgpt.com/codex/cloud/settings/analytics) and expose it through `/usage`.

## Step 1: authentication

The extension reads the existing Codex CLI credential directly from:

- `$CODEX_HOME/auth.json`, when `CODEX_HOME` is set; or
- `~/.codex/auth.json` otherwise.

It extracts only the ChatGPT access token and account ID. It does not print, cache, copy to Keychain, or persist either value.

Run:

```text
/usage auth status
```

The command checks that the file and required fields exist, detects an expired JWT when possible, and validates the credential against ChatGPT's authenticated Codex quota endpoint. That endpoint is used only as an authentication smoke test, not as the analytics data source.

If authentication is missing, invalid, expired, or rejected, run:

```bash
codex login
```

## Step 2: endpoint probe

An isolated browser capture confirmed that the Analytics page makes authenticated `GET` requests to:

- `/backend-api/wham/usage`
- `/backend-api/wham/usage/daily-token-usage-breakdown`
- `/backend-api/wham/analytics/daily-workspace-usage-counts`
- `/backend-api/wham/analytics/daily-skill-usage-metrics`
- `/backend-api/wham/analytics/daily-plugin-usage-metrics`
- `/backend-api/wham/usage/credit-usage-events`

The dated endpoints use an inclusive 30-day UTC range and `group_by=day`; workspace, skill, and plugin requests use `workspace_user=true`. The Codex CLI bearer token and account ID are sufficient—browser cookies and browser profile access are not required after discovery.

Run:

```text
/usage probe
```

The probe reports authentication rejection, endpoint availability, invalid JSON, oversized responses, or an unrecognized response contract without including credentials or response bodies in errors.
