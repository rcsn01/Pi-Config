# Plan: keep the current Permission authorization seams

> **Status:** Review complete. Make no production-code change. The typed Guardian request flow is already in the current tree, introduced by `7c0a5fa`. Git history does not support the previous draft's claim that the root plan was an uncommitted Guardian-request plan: the committed `plan.md` at `HEAD` documents the completed Permission ask-prose change from `5ad7d1b`.

## Decision

Keep Permission classification separate from Permission enforcement. Do not add another Guardian request type, serializer, or policy module.

`permission-policy.ts` is a pure classifier. It returns ordered block and ask steps without calling the host or keeping mutable state. `permission-enforcement-lifecycle.ts` resolves those steps asynchronously and owns mode state, Guardian fallback, verdict persistence, prompted denials, and one-shot retry approvals. Combining them would put stateful host effects into classification and make the classifier's direct tests depend on lifecycle setup.

The Guardian modules also have distinct work. `guardian-evidence.ts` selects and bounds conversation evidence, copies it into a typed semantic request, and bounds the action description. `guardian-verdict.ts` maps that request to the schema-version-2 prompt and validates the response. `guardian-runner.ts` owns the isolated model session, timeout, review locking, usage, and observability. None is a pass-through awaiting consolidation.

The existing request flow is already typed end to end: the lifecycle builds a `GuardianReviewRequest`, the adapter in `index.ts` passes it to `approvals.ts`, and that adapter passes the same object to `guardian-runner.ts`. `approvals.ts` also adapts provider registrations from Pi's model registry. Do not add another serialization layer. The schema-v2 wire prompt currently repeats the action title at the top level and under `evidence.action`; the exact-prompt test pins both fields. Leave that prompt shape unchanged in this plan. Keep the full classified message in the lifecycle for user fallback; the request's action description is bounded to 8,000 characters.

## Scope and behavior to preserve

1. Keep classification pure and preserve its check order: execpolicy; read-only restrictions; default sensitive-path reads; Bash checks; default network tools; default and auto-review external-path writes. The classifier can return steps after a block. The lifecycle walks them in order and stops at the first block or denied ask. In particular, preserve ask-then-block and ask-block-ask sequences rather than filtering or reordering steps.
2. Keep user-channel prompt text final in classification and pass it unchanged through the lifecycle. The helper composes `Proceed?` by default and external-write asks use `Allow write?`; the execpolicy ask is an inline final message. Guardian fallback prompts are separate resolution-outcome text and stay lifecycle-owned.
3. Preserve Guardian trigger values and order. The vocabulary is `dangerous`, `network`, `repository-snapshot-removal`, `external-path`, and `external-write`. Bash auto-review assembles its triggers in the first four's listed order; external `write`/`edit` reviews use `external-write`.
4. Preserve the evidence rules. `index.ts` builds evidence from the active Session branch, keeps up to three recent user turns and their preceding assistant replies, excludes the current tool-calling assistant, and applies a 16,000-character default shared budget newest-first. Skill provenance is included only for an explicitly invoked Skill captured before expansion. `buildGuardianReviewRequest` copies that snapshot and bounds only the action description to 8,000 characters, preserving its ends when it truncates. The production adapter supplies the bounded conversation snapshot; the request builder does not independently bound an arbitrary `GuardianContextSnapshot` supplied by another caller.
5. Preserve the full fallback description. The lifecycle passes the original classified message separately from the bounded Guardian request, so a fallback prompt can include text omitted from the Guardian description.
6. Preserve no-UI and Guardian failure behavior. Execpolicy prompt rules become classifier blocks without UI. Other user asks can still be classified without UI, but the default-mode lifecycle denies them without showing a prompt. Auto-review with no UI denies before calling Guardian or persisting a verdict. With UI, a thrown/rejected review adapter or a thrown verdict-persistence adapter triggers direct user confirmation. If the runner returns a fail-closed Guardian denial and verdict persistence succeeds, the lifecycle records the denial and blocks without a second confirmation; if persistence throws, the verdict-write fallback applies. If fallback confirmation itself rejects, that rejection propagates and the lifecycle does not request confirmation again.
7. Preserve denial and retry state. One-shot approvals are keyed by tool name plus canonicalized input, consumed once, cleared on mode change or a fresh session reset, and retained for a session-tree update that does not request a reset. A denial is retryable only when UI is available and the evaluation's authorization generation has not changed.
8. Preserve Session verdict entries. `index.ts` appends `auto-review-verdict` with `title`, `allowed`, and `reason`, plus `model` and `usage` when present and `triggers` when non-empty. A failed append follows the verdict-write fallback above. Do not change this entry shape, renderer, or trigger order.

Do not expand this work into the mode registry, mode persistence, Guardian policy, or UI. No interface or type changes are needed. `CONTEXT.md` already describes the Permission modules, bounded Guardian evidence, typed request, schema-v2 verdict protocol, and fallback ownership; leave it unchanged.

## Current flow and test evidence

1. `index.ts` captures Pi events and the active branch's Session context, then supplies the environment to the lifecycle. The Pi adapter owns concrete confirmation, Guardian execution, and Session-entry effects.
2. `permission-policy.ts:classifyToolCall` returns ordered steps, including final user-ask messages and Guardian triggers. The mode/check-order scenarios are pinned in `permission-policy.test.ts`.
3. `permission-enforcement-lifecycle.ts:evaluate` resolves each step using the current mode snapshot, stops at a block or denied ask, and records prompted denials for `/approve`'s one-shot retry path. Its no-UI, ordering, state-reset, and fallback cases are pinned in `permission-enforcement-lifecycle.test.ts`.
4. For a Guardian step, the lifecycle builds a copied request from the supplied evidence and classified action. If a fallback is needed, it uses the original classified message, not the bounded request description.
5. The same request object flows through the `index.ts` adapter and `approvals.ts` to `runAutoReviewer`. `guardian-verdict.ts:composeGuardianTask` owns the schema-v2 wire prompt. The adapter's request identity and provider-registration behavior are pinned in `approvals.test.ts`; branch evidence, Skill provenance, and persisted verdicts are pinned in `index.test.ts`.
6. `guardian-evidence.test.ts` covers the recent-turn selection, truncation boundaries, omitted context, and snapshot copying. `guardian-verdict.test.ts` pins the exact prompt envelope and response-validation decisions: invalid, multiple, wrong-name, stopped, or errored classification calls fail closed; malformed tool arguments cannot be bypassed by later prose; exact whole-response JSON is accepted only when no tool call exists. `guardian-runner.test.ts` covers decisions, failures, timeouts, review locking, and usage; `guardian-runner-config.test.ts` covers isolated-session configuration.
7. The prompt-prose invariant test in `permission-policy.test.ts` is a fixed sample, not a universal proof: nine scenarios produce ten user asks, and the test checks that each ends in `?` and contains `Proceed?` at most once. It does not enumerate every possible mode/input or count all question marks. The per-site snapshots and other mode/order tests pin current cases. Do not describe that matrix as covering every future hand-written ask.

The safety command is defined by `.pi/package.json` as `vitest run extensions/policy-permissions`. I reran `pnpm test:safety` from `.pi/`: all 15 test files and 196 tests passed. The other seven files in that run cover commands, Guardian configuration/observation/settings, mode registry/store, and path policy: `commands.test.ts`, `guardian-config.test.ts`, `guardian-observer.test.ts`, `guardian-settings.test.ts`, `mode-registry.test.ts`, `mode-store.test.ts`, and `path-policy.test.ts`.

## Alternatives rejected

### Combine classification and enforcement

Rejected. Classification is pure policy data; enforcement handles asynchronous resolution and state transitions. Keeping their current interface lets tests exercise each responsibility directly and keeps Pi effects out of policy decisions.

### Add another Guardian request or serializer module

Rejected. `guardian-evidence.ts` owns the semantic request and its bounds. `guardian-verdict.ts` owns the wire conversion. The existing adapter forwards the same request and supplies provider configuration; another layer would duplicate those responsibilities without another consumer.

### Move fallback text into the request

Rejected. Guardian action descriptions are capped at 8,000 characters, while fallback confirmation needs the full classified message. Keep those values separate.

### Broaden the change into modes or persistence

Rejected. No current bug or policy requirement calls for changes to mode semantics, storage, Guardian policy, or the `auto-review-verdict` entry. Those are separate decisions, not reasons to reshape this seam.

## Execution checklist

1. Edit only root `plan.md`. Do not change Permission source, tests, `CONTEXT.md`, `guardian.md`, `.pi/profiles/ollama.json`, or `.pi/settings.json`.
2. Record the focused baseline above. Since this plan changes no source, do not run typechecking or the repository-wide suite for this plan-only task.
3. If a future behavior change is approved, add or identify a focused regression test, then run `pnpm test:safety` and `pnpm typecheck` from `.pi/`. Run the full `pnpm test` only if that change crosses broader integration paths.

## Acceptance criteria

- No production source, tests, `CONTEXT.md`, or `guardian.md` changes.
- No permission prompt, Guardian prompt, Session entry, fallback, approval state, or persisted verdict behavior changes.
- The focused safety baseline remains 15 test files and 196 passing tests.
- Only root `plan.md` is intentionally changed; configuration files remain out of scope.

## Reopen conditions

Revisit this decision if a reproducible prompt, authorization, ordering, fallback, or persistence bug is not covered by the existing tests; if a classification rule must be maintained in multiple callers; if a real second adapter is needed; or if a changed policy requirement cannot be represented through the current classification result or lifecycle interface.
