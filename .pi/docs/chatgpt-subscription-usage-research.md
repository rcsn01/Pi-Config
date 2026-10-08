# ChatGPT subscription quota support

## Findings

The current Sign in with ChatGPT flow and the legacy Codex flow are different authentication contracts. The installed Pi 1.0.4 registers the current flow under `openai`; `openai-codex` is labeled legacy. Its `openai-chatgpt.js` requests `chatgpt.tokens.use.direct` for `https://api.openai.com/v1` and converts the saved OAuth access token into request authentication.

OpenAI's [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) documents that audience and an opaque `encrypted_auth_metadata` claim. It does not document the `chatgpt_account_id` claim consumed by this repository's legacy Codex quota client. The metadata must remain opaque, not decoded or repurposed as an account ID.

OpenAI's [models and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) documents `GET https://api.openai.com/v1/models` and streaming `POST https://api.openai.com/v1/responses`. It explicitly tells integrations not to direct this inference flow to ChatGPT backend-api endpoints. This is not evidence that a private quota endpoint cannot exist, but it provides no supported contract for reusing the legacy quota endpoint with the new token.

The [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) direct integrations to place a Manage usage link to `https://chatgpt.com/settings/usage` near usage summaries and usage-limit errors. They describe both plan-level and app-specific limits. They do not specify an HTTP quota-read endpoint, authorization headers, or a response schema.

The [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source), [quickstart](https://developers.openai.com/siwc/quickstart), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) describe eligible plan-powered inference but do not provide a quota-read API contract. [Codex pricing](https://developers.openai.com/codex/pricing) points users to a dashboard and the Codex CLI's `/status`, not a new SIWC quota endpoint.

## Recommendation

No quota-read API for the new flow exists in any documented or reverse-engineered surface, confirmed by live probes (below). Do not invent an endpoint, decrypt authentication metadata, send the new API-audience token to the legacy quota backend, or label organization API usage as ChatGPT subscription quota.

For `/usage`, recognize current `openai` OAuth through Pi's runtime authentication metadata without reading or displaying tokens. Show that the user is signed in and explain that numeric quota is unavailable through this integration, with the official Manage usage URL. Do not request a legacy login when a current subscription login already exists. Retain legacy slot probing only when the current subscription login is not in use.

## Deeper research round (live probes and third-party clients)

Follow-up research went beyond the docs into reverse-engineered clients and live, read-only probes with the locally signed-in SIWC token. Probes printed only statuses, header/claim names, and machine-readable error codes; no token values were sent anywhere except the target hosts and never logged.

### Live probes (read-only GETs)

The local SIWC access token carries claims `sub`, `aud` (`https://api.openai.com/v1`), `client_id`, `scope`, `https://api.openai.com/auth` (opaque `per_user_salt` + `encrypted_auth_metadata`), `iss`, `iat`, `exp`, `jti`, `nbf` — no `chatgpt_account_id`.

| Request | Result |
| --- | --- |
| `GET https://chatgpt.com/backend-api/wham/usage` with SIWC bearer, no account header | `401`, `error.code: no_matching_rule`, `error.type: rejected_by_access_enforcement`, header `x-openai-authorization-error` present. The backend access enforcer has no admission rule for this token: structural rejection, not expiry or a transient fault. |
| `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` with SIWC bearer | `401`, same rejection shape. |
| `GET https://api.openai.com/v1/models` with SIWC bearer (documented call) | `200`. Response header names contain no rate-limit or usage fields (no `x-ratelimit-*`, no `x-codex-*`); body is only a `models` array. |

Conclusion from probes: the legacy `wham` endpoints are closed to SIWC tokens, and the documented direct-route surface exposes no quota-read endpoint or usage headers on a free call. A possible usage-header surface on `POST /v1/responses` responses would require spending plan usage to observe and was deliberately not tested; even if present, the errors guide says limits are not distinguishable/resettable from the 429 alone.

### Reverse-engineered clients inspected

- **[timm-u/pi-usage](https://github.com/timm-u/pi-usage)** (snapshot `c8b1e61`): a Pi extension that already implements Codex usage. It scans Pi's `auth.json` for an OAuth credential under the `openai` key (so it anticipates the new login) but requires a `chatgpt_account_id` — from the stored `accountId` field or decoded from the access-token claim `https://api.openai.com/auth`. SIWC tokens lack that claim, so for a pure SIWC login it shows nothing for Codex. It calls `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer` + `ChatGPT-Account-Id`, falls back to a probe of `POST https://chatgpt.com/backend-api/codex/responses` reading `x-codex-*` usage headers (legacy backend, same account-scoped requirement), and parses `plan_type`, `rate_limit.{limit_reached, primary_window, secondary_window}` with `used_percent` / `limit_window_seconds` (18000 s = 5 h, 604800 s = weekly) / `reset_after_seconds` / `reset_at`, plus `code_review_rate_limit` and `credits.{has_credits, unlimited, balance}`.
  - Caution: it would also call the legacy refresh endpoint (`auth.openai.com/oauth/token`, legacy client ID) with a SIWC refresh token when refreshed credentials lack an account ID. That is unsafe for rotating SIWC refresh tokens (`refresh_token_reused` is a documented invalidation error) and should not be replicated.
- **[steipete/CodexBar](https://github.com/steipete/CodexBar)** (snapshot `a379b25`): exposes four Codex usage data sources, none SIWC-compatible: (1) a PAT, (2) the Codex CLI's own OAuth credentials from `~/.codex/auth.json` (legacy account-scoped token) against `wham/usage`, (3) JSON-RPC `account/read` and `account/rateLimits/read` through `codex app-server` (the same server wraps `wham/usage` when running in ChatGPT auth mode; with the SIWC config from official docs it runs `requires_openai_auth=false` against `api.openai.com` with no rate-limit channel), and (4) an optional hidden-WebView scrape of `https://chatgpt.com/codex/cloud/settings/analytics#usage` using imported chatgpt.com browser cookies — user session cookies, not the OAuth bearer.
- **[Unofficial wham/usage reference](https://gist.github.com/monperrus/21dc7d85ea518dc2a66606006d356b5b)** and secondary write-ups (workos.com, byteiota.com, apidog.com): all document only the legacy account-scoped contract and the 429 `subscription_sharing_usage_limit_exceeded` error plus the dashboard; none describe an SIWC-compatible usage read.

### T3 Code (pingdotgg/t3code @ `12069ee`, plus openai/codex @ `9b73858`)

T3 Code ships ChatGPT-plan usage today. Its approach, from source read-only inspection (no repository code executed):

1. **It implements the SIWC OAuth itself** in `apps/server/src/provider/CodexChatGptAuth.ts` — OIDC discovery at `https://auth.openai.com/.well-known/openid-configuration`, dynamic client registration, scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`, refresh through the SIWC endpoint with rotation guards (`refresh_token_reused` etc. mapped to a re-sign-in state) and an `earliest_refresh_at` floor. Tokens live in T3's own credential store; it never writes the Codex CLI's `auth.json`.
2. **It drives the real Codex CLI app-server for inference**, not its own HTTP calls: the managed runtime spawns `codex app-server` with `model_provider="openai_token_sharing"` pointed at `https://api.openai.com/v1`, `env_key="ACCESS_TOKEN"`, `wire_api="responses"`, `requires_openai_auth=false`, passing the SIWC access token via `ACCESS_TOKEN` in a shadow `CODEX_HOME` and deleting ambient `OPENAI_API_KEY`/`OPENAI_BASE_URL` (`CodexManagedRuntime.ts`).
3. **Usage read**: `codexUsageLimits.ts` maps only two app-server channels. `account/read` + `account/rateLimits/read` during provider probes — but the CLI source (`app-server/src/request_processors/account_processor.rs` `get_account_rate_limits_response`) replies `"chatgpt authentication required to read rate limits"` unless the CLI itself holds a Codex-backend auth (its own ChatGPT login; `core/src/client.rs` `uses_codex_backend` requires `requires_openai_auth` and no `env_key`). So for T3-managed SIWC sessions the probe degrades to a failure row; the rich window/credit display works for users whose `CODEX_HOME` has a native Codex login.
4. **Turn-driven usage via push notifications**: during real turns T3 consumes `account/rateLimits/updated` from the app-server and merges partial snapshots (`mergeCodexRateLimits`). In the CLI, those notifications originate from **response headers of every `/responses` call**: `codex-api/src/rate_limits.rs` parses the generic families `x-<limit-id>-primary-used-percent`, `x-<limit-id>-primary-window-minutes`, `x-<limit-id>-primary-reset-at` (plus `secondary`, `x-codex-credits-has-credits`/`-unlimited`/`-balance`, `x-codex-rate-limit-reached-type`, `x-codex-promo-message`) from `stream_response.headers` in `codex-api/src/sse/responses.rs` — provider-agnostic, applied to env-token/API-key providers too — and also a `codex.rate_limits` SSE event (`parse_rate_limit_event`) on the websocket path. Snapshots merge into session state (`state/session.rs` `set_rate_limits`) and flow out as notifications.

The same mechanism would be the first genuinely supported path for Pi's `/usage` with the current login: parse usage/rate-limit headers from Pi's own Responses API responses (no extra requests, no undocumented endpoint). The single unverified link is whether OpenAI's direct route attaches `x-codex-*` headers for token-sharing tokens (`/v1/models` showed none, but inference responses are the header surface the CLI reads; confirming requires one real inference response, which was deliberately not sent during this research). The alternative of proxying through `codex app-server` RPCs only helps where a native codex login coexists; the probe errors under env-token auth.

### What remains observable for SIWC

The only usage signals a client can observe through the supported direct route are the structured error codes: 429 `subscription_sharing_usage_limit_exceeded` (pause and link to `https://chatgpt.com/settings/usage`; do not infer a reset time; an app-specific limit can also apply), 503 `subscription_sharing_usage_unavailable`, and 403 `subscription_sharing_user_not_eligible`. A session-level "plan limit reached" indicator could be implemented from the 429 without any new API call, and per the T3 Code section above, per-turn `x-codex-*` response headers (if the direct route emits them) are the one supported path to numeric windows/resets for this login type. If the user separately performs the legacy Codex login (`/login openai-codex`), the existing slot-based quota display continues to work for that credential.

## Local evidence

- `.pi/extensions/provider-usage/src/index.ts` constructs `CodexSlotUsageClient`, which only consults legacy Codex slots.
- `.pi/extensions/provider-codex/credential-slots.ts` uses `openai-codex` and requires a `chatgpt_account_id` token claim.
- `.pi/extensions/provider-usage/src/quota-client.ts` calls `https://chatgpt.com/backend-api/wham/usage` with the legacy token and account ID.
- Installed Pi 1.0.4 source was inspected read-only at `~/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-ai/dist/providers/openai.js`, `providers/openai-codex.js`, and `auth/oauth/openai-chatgpt.js`.
- Only credential provider/type metadata and token-field names were inspected locally to confirm the reported mismatch, plus read-only live probes described above. No token values, account identifiers, or other private values were logged. No request was made that spends plan usage (`POST` on the direct route was deliberately avoided); all probes were `GET`.
- Snapshots used for this round (read-only, no repository code executed): timm-u/pi-usage @ `c8b1e61` and steipete/CodexBar @ `a379b25` under `.pi/repos/`.

The repository pins Pi libraries at 0.87.0 while the running managed installation is 1.0.4. Implementation should use an existing public runtime metadata interface rather than importing the repository's older OpenAI provider for the new OAuth flow.
