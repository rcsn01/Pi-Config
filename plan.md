Extension Refactoring Roadmap

Summary

Create EXTENSION_REFACTOR_PLAN.md in the repository root. The document will define a staged refactor
in which each extension is handled and verified independently. Generated lockfiles will remain
untouched.

Stage 0: Establish Baseline

Before moving code:

- Run the complete .pi test suite and typecheck.
- Record the existing extension interfaces and exported symbols.
- Preserve each extension’s default index.ts entrypoint.
- Avoid behavior changes during structural extraction.
- Keep unrelated working-tree changes untouched.
- Use focused tests after each stage and the complete suite once at the end.

Stage 1: Web Fetch Extension

Refactor .pi/extensions/tools-web-fetch/index.ts first because it already has clear internal seams.

Target structure:

```text
  tools-web-fetch/
  ├── index.ts
  ├── fetch-document.ts
  ├── http-client.ts
  ├── pdf-extractor.ts
  ├── rsc-extractor.ts
  ├── html-extractor.ts
  └── jina-reader.ts
```

Responsibilities:

- index.ts: tool registration and input/output adaptation.
- fetch-document.ts: extraction strategy orchestration.
- http-client.ts: requests, caching, timeouts, and size limits.
- pdf-extractor.ts: PDF detection and text extraction.
- rsc-extractor.ts: Next.js RSC parsing.
- html-extractor.ts: HTML and readability extraction.
- jina-reader.ts: Jina fallback adapter.

Verification:

- Add focused tests for extraction strategy selection and fallback behavior where coverage is
  absent.
- Run Web Fetch tests and typecheck.
- Confirm the registered tool interface remains unchanged.

Stage 2: Plan Mode Extension

Continue the existing Plan Mode modularization without changing its command behavior, Shift+Tab
shortcut, sandbox lifecycle, or fresh-session-first review flow.

Target structure:

```text
  workflows-plan-mode/
  ├── index.ts
  ├── plan-content.ts
  ├── plan-state.ts
  ├── plan-review.ts
  ├── plan-renderer.ts
  ├── plan-question.ts
  ├── plan-prompt.ts
  ├── plan-runtime.ts
  ├── plan-sandbox.ts
  ├── plan-workspace.ts
  └── model-profile.ts
```

Responsibilities:

- index.ts: extension composition, event registration, and command wiring.
- plan-content.ts: proposed-plan tags, normalization, signatures, and duplicate detection.
- plan-state.ts: state persistence and reconstruction.
- plan-review.ts: review actions and implementation handoffs.
- plan-renderer.ts: custom message and proposed-plan rendering.
- plan-question.ts: clarification tool schema and behavior.
- plan-prompt.ts: Plan Mode system instructions.

Split the large test file by behavior:

```text
  plan-content.test.ts
  plan-state.test.ts
  plan-review.test.ts
  plan-lifecycle.test.ts
  plan-question.test.ts
  plan-renderer.test.ts
  test-harness.ts
```

Verification:

- Run all Plan Mode tests.
- Run the macOS sandbox integration test.
- Run typecheck.
- Preserve lifecycle race, fail-closed, action-ordering, and model-profile coverage.

Stage 3: Subagents Extension

Extract process execution, rendering, discovery, and model configuration behind small interfaces.

Target structure:

```text
  tools-subagents/
  ├── index.ts
  ├── agent-registry.ts
  ├── config.ts
  ├── subagent-runner.ts
  ├── parallel-runner.ts
  ├── progress-renderer.ts
  ├── model-commands.ts
  ├── formatting.ts
  └── test-harness.ts
```

Responsibilities:

- index.ts: tool and command registration.
- agent-registry.ts: discovery, registration, and lookup.
- config.ts: configuration loading and validation.
- subagent-runner.ts: subprocess execution and streamed output parsing.
- parallel-runner.ts: concurrency limits and result ordering.
- progress-renderer.ts: terminal presentation.
- model-commands.ts: model selection, status, and configuration commands.
- formatting.ts: token, duration, and preview formatting.

Verification:

- Preserve existing exported runner and registration interfaces.
- Test single and parallel execution independently.
- Test timeout, abort, malformed stream, and partial-result behavior.
- Run Subagents tests and typecheck.

Stage 4: Safety Permissions Extension

Create a deep permission-policy module instead of distributing policy decisions across event
handlers.

Target structure:

```text
  safety-permissions/
  ├── index.ts
  ├── permission-policy.ts
  ├── path-policy.ts
  ├── guardian-runner.ts
  ├── approvals.ts
  ├── mode-store.ts
  ├── commands.ts
  └── policy-types.ts
```

Primary seam:

```ts
  evaluateToolCall(input, context): PermissionDecision
```

Responsibilities:

- index.ts: Pi event registration and decision enforcement.
- permission-policy.ts: pure permission classification.
- path-policy.ts: workspace, sensitive, and external path detection.
- guardian-runner.ts: guardian subprocess execution and verdict parsing.
- approvals.ts: user and guardian approval flow.
- mode-store.ts: permission-mode persistence.
- commands.ts: /permissions and /execpolicy.
- policy-types.ts: shared decision and context types.

Verification:

- Add table-driven tests around the policy interface.
- Cover read-only, default, auto-review, external paths, network commands, dangerous Bash, and
  guardian failure.
- Verify fail-closed behavior remains unchanged.
- Run Safety Permissions tests and typecheck.

Stage 5: Final Verification

After all extension stages:

- Run the complete .pi test suite.
- Run typecheck.
- Run integration tests required by changed seams.
- Run git diff --check.
- Confirm extension catalog and settings JSON remain valid.
- Perform one consolidated correctness review.
- Confirm no generated lockfile was manually split or rewritten.

Explicit Exclusions

Do not manually refactor or split:

```text
  .pi/pnpm-lock.yaml
  .pi/extensions-disabled/integration-plane/package-lock.json
```

Do not combine structural extraction with feature changes unless a correctness issue makes the
change necessary.
