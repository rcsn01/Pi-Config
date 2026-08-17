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

The analytics endpoint is intentionally not guessed. It will be added after capturing the Fetch/XHR request made by the Analytics page.
