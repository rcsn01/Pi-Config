# ChatGPT subscription quota support

## Findings

The current Sign in with ChatGPT flow and the legacy Codex flow are different authentication contracts. The installed Pi 1.0.4 registers the current flow under `openai`; `openai-codex` is labeled legacy. Its `openai-chatgpt.js` requests `chatgpt.tokens.use.direct` for `https://api.openai.com/v1` and converts the saved OAuth access token into request authentication.

OpenAI's [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) documents that audience and an opaque `encrypted_auth_metadata` claim. It does not document the `chatgpt_account_id` claim consumed by this repository's legacy Codex quota client. The metadata must remain opaque, not decoded or repurposed as an account ID.

OpenAI's [models and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) documents `GET https://api.openai.com/v1/models` and streaming `POST https://api.openai.com/v1/responses`. It explicitly tells integrations not to direct this inference flow to ChatGPT backend-api endpoints. This is not evidence that a private quota endpoint cannot exist, but it provides no supported contract for reusing the legacy quota endpoint with the new token.

The [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) direct integrations to place a Manage usage link to `https://chatgpt.com/settings/usage` near usage summaries and usage-limit errors. They describe both plan-level and app-specific limits. They do not specify an HTTP quota-read endpoint, authorization headers, or a response schema.

The [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source), [quickstart](https://developers.openai.com/siwc/quickstart), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) describe eligible plan-powered inference but do not provide a quota-read API contract. [Codex pricing](https://developers.openai.com/codex/pricing) points users to a dashboard and the Codex CLI's `/status`, not a new SIWC quota endpoint.

## Recommendation

No publicly documented quota-read API for the new flow was found in the primary sources above. That is an evidence limit, not proof of impossibility. Do not invent an endpoint, decrypt authentication metadata, send the new API-audience token to the legacy quota backend, or label organization API usage as ChatGPT subscription quota.

For `/usage`, recognize current `openai` OAuth through Pi's runtime authentication metadata without reading or displaying tokens. Show that the user is signed in and explain that numeric quota is unavailable through this integration, with the official Manage usage URL. Do not request a legacy login when a current subscription login already exists. Retain legacy slot probing only when the current subscription login is not in use.

## Local evidence

- `.pi/extensions/provider-usage/src/index.ts` constructs `CodexSlotUsageClient`, which only consults legacy Codex slots.
- `.pi/extensions/provider-codex/credential-slots.ts` uses `openai-codex` and requires a `chatgpt_account_id` token claim.
- `.pi/extensions/provider-usage/src/quota-client.ts` calls `https://chatgpt.com/backend-api/wham/usage` with the legacy token and account ID.
- Installed Pi 1.0.4 source was inspected read-only at `~/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-ai/dist/providers/openai.js`, `providers/openai-codex.js`, and `auth/oauth/openai-chatgpt.js`.
- Only credential provider/type metadata and token-field names were inspected locally to confirm the reported mismatch. No token values, account identifiers, or other private values were logged. No authenticated request was made.

The repository pins Pi libraries at 0.87.0 while the running managed installation is 1.0.4. Implementation should use an existing public runtime metadata interface rather than importing the repository's older OpenAI provider for the new OAuth flow.
