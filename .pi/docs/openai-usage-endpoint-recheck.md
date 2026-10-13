# OpenAI remaining-usage endpoint recheck

## Result

No supported endpoint to read remaining ChatGPT subscription usage was found in the current first-party Sign in with ChatGPT token-sharing documentation reviewed. This is an absence from the reviewed public contracts, not proof that no private endpoint exists.

The existing provider-usage behavior remains appropriate for the current `/login openai` flow: recognize OAuth, explain that numeric quota is unavailable through the integration, and link to https://chatgpt.com/settings/usage. No extension code was changed during this recheck.

## First-party evidence

- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) documents `GET https://api.openai.com/v1/models` and `POST https://api.openai.com/v1/responses` with an OAuth bearer token. It explicitly tells integrations not to point this plan-usage inference flow at ChatGPT `backend-api` endpoints. It provides no remaining-quota endpoint.
- The researcher reviewed the [complete SIWC documentation export](https://developers.openai.com/siwc/llms-full.txt) and found no remaining-balance URL, quota-read scope, or quota-response schema.
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) documents the `https://api.openai.com/v1` audience and `chatgpt.tokens.use.direct` permission. Authentication metadata is opaque, not a source of account identity or remaining quota.
- [UI guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) direct integrations to put a Manage usage link to ChatGPT settings near usage summaries and usage-limit errors. They do not specify a quota-read API.
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) documents HTTP 429 `subscription_sharing_usage_limit_exceeded`. It explicitly says not to infer that the whole plan is empty or infer a reset time, because an app-specific limit can apply.
- The [organization Usage API](https://platform.openai.com/docs/api-reference/usage) reports historical consumption and costs. This is not remaining ChatGPT subscription allowance. The researcher could not fully extract the endpoint/authentication sections, so this recheck does not establish a new authentication contract for those APIs.

## Repository comparison

- `.pi/extensions/provider-usage/src/index.ts` checks the runtime's `openai` OAuth metadata. For the current login it displays the usage-settings link without attempting the legacy quota request.
- `.pi/extensions/provider-usage/src/quota-client.ts` uses `GET https://chatgpt.com/backend-api/wham/usage` for legacy Codex credentials. The current SIWC docs do not newly authorize that endpoint for token-sharing credentials.
- Prior research lives in `.pi/docs/chatgpt-subscription-usage-research.md`. Its historical authenticated probes were not repeated here. Its broad claim that no endpoint exists anywhere should be read more narrowly: no supported endpoint was identified in reviewed documentation, and the specific legacy probes failed.

## Limits and next possible check

No credentials were read, no authenticated probes were made, and no inference usage was spent. Numeric subscription-remaining headers on real SIWC Responses requests remain unverified. Inspecting headers from an already-authorized normal inference response could test that possibility without an extra quota probe, but this recheck did not do so. Organization API accounting and generic request/token rate-limit headers must not be labeled as ChatGPT plan remaining usage.
