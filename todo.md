# Pi Catalog Adoption TODO

This file tracks only pending work involving packages from the [Pi package catalog](https://pi.dev/packages). The repository comparison, local architecture, and extension hardening work are complete.

Catalog records and metadata were reviewed on 2026-08-10. Except where source is already present in this workspace, the package source and license have not yet been verified. No catalog package is currently installed.

## Adoption rules

- Keep exactly one owner for permissions, subagents, workflows, todos, goals, memory, editing, questions, and the footer.
- Prefer integrating a narrow capability into an existing local extension over adding another owner.
- Use a thin local extension adapter for a broad package that should remain an npm dependency.
- Before adopting code, retrieve the exact package version, inspect its source and dependencies, verify its license, and record attribution requirements.
- Test on Windows first, then run the full cross-platform suite.
- For a replacement, migrate state and focused tests and remove the old owner in the same change.

## Integrate

Work through these one at a time. Do not install the next package until the previous integration passes the full suite.

| Done | Package | Target | Required checks |
|---|---|---|---|
| [ ] | [`@juicesharp/rpiv-ask-user-question`](https://pi.dev/packages/@juicesharp/rpiv-ask-user-question) | Port suitable behavior into `tools-ask-user`, keeping it the sole question owner. | Source, license, headless behavior, cancellation, multi-select, full suite. |
| [ ] | [`@narumitw/pi-lsp`](https://pi.dev/packages/@narumitw/pi-lsp) | Port focused diagnostics, definition, references, and symbol navigation into `tools-lsp`. Source is available in the local `pi-extensions` checkout. | License, Pi 0.84.1 API compatibility, Windows language-server discovery, cancellation, full suite. |
| [ ] | [`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro) | Add one local anchored-edit owner, either by a narrow port or a thin npm adapter after source review. | Source, license, CRLF, Unicode, stale hashes, cancellation, large files, full suite. |
| [ ] | [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) | Add as an optional integration extension through a thin adapter; do not merge MCP into native local tools. | Source, license, explicit server allowlist, timeouts, cancellation, secret boundaries, full suite. |
| [ ] | [`pi-agent-browser-native`](https://pi.dev/packages/pi-agent-browser-native) | Add as an optional research extension through a thin adapter. Keep no-key search and fetch as defaults. | Source, license, browser lifecycle, cancellation, downloads, Windows support, security review, full suite. |
| [ ] | [`pi-hermes-memory`](https://pi.dev/packages/pi-hermes-memory) | Evaluate as an optional and initially disabled memory extension. Remove or leave `sessions-memory` disabled if adopted. | Source, license, provenance, project isolation, secret scanning, retention, export, deletion, full suite. |

## Conditional replacements

These packages are not additive TODOs. Evaluate one only when its named capability becomes insufficient, and never load it beside the current owner.

| Done | Package | Would replace | Adoption condition |
|---|---|---|---|
| [ ] | [`@gotgenes/pi-permission-system`](https://pi.dev/packages/@gotgenes/pi-permission-system) | `safety-permissions` and shared policy provider | Its tested coverage and child-process inheritance must exceed the local policy implementation. |
| [ ] | [`pi-subagents`](https://pi.dev/packages/pi-subagents) | `tools-subagents` | Multi-backend execution becomes required and the package can satisfy the shared service and cancellation contracts. |
| [ ] | [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents) | `tools-subagents` | Its richer orchestration is required and justifies the larger surface. |
| [ ] | [`@quintinshaw/pi-dynamic-workflows`](https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows) | `workflows-runtime` | Runtime-defined workflows become required and the expanded trust boundary is accepted. |
| [ ] | [`@mjasnikovs/pi-task`](https://pi.dev/packages/@mjasnikovs/pi-task) | `workflows-runtime` and parts of todo/goal ownership | The local task stack is deliberately replaced as a whole. |
| [ ] | [`pi-fabric`](https://pi.dev/packages/pi-fabric) | `tools-subagents` and `workflows-runtime` | Distributed message-oriented routing becomes a requirement. |
| [ ] | [`pi-web-access`](https://pi.dev/packages/pi-web-access) | `tools-web-search`, `tools-web-fetch`, and research providers | A unified provider proves more reliable than the independent local tools. |
| [ ] | [`pi-lens`](https://pi.dev/packages/pi-lens) | Focused LSP and separate code-intelligence tools | A combined LSP, lint, and intelligence owner is intentionally preferred. |
| [ ] | [`pi-readseek`](https://pi.dev/packages/pi-readseek) | `tools-file-picker` and anchored editing | The all-in-one read/search/edit surface is preferred over the smaller composition. |
| [ ] | [`@juicesharp/rpiv-todo`](https://pi.dev/packages/@juicesharp/rpiv-todo) | `tools-todo` | It passes equivalent reconstruction, unique-ID, and single-active-task tests. |
| [ ] | [`@narumitw/pi-plan-mode`](https://pi.dev/packages/@narumitw/pi-plan-mode) | `workflows-plan-mode` | It provides measurably better read-only enforcement and handoff behavior. |
| [ ] | [`@narumitw/pi-goal`](https://pi.dev/packages/@narumitw/pi-goal) | `workflows-goal` | Autonomous goal continuation is enabled and its budget/no-progress protections are retained. |
| [ ] | [`@narumitw/pi-statusline`](https://pi.dev/packages/@narumitw/pi-statusline) | `ui-status-separators` | Its presentation is preferred; retain the shared usage collector and remove the old footer owner. |
| [ ] | [`pi-powerline-footer`](https://pi.dev/packages/pi-powerline-footer) | `ui-status-separators` | Its presentation is preferred and it passes cross-platform checks. |

## Do not adopt

These decisions are closed for the current suite. Reopen one only when a concrete unmet requirement is documented.

| Package | Reason |
|---|---|
| [`opencode-codebase-index`](https://pi.dev/packages/opencode-codebase-index) | No inspectable source was available during review and no measured semantic-search gap exists. |
| [`@ff-labs/pi-fff`](https://pi.dev/packages/@ff-labs/pi-fff) | Duplicates bounded `fd`/`rg`/Node file discovery. |
| [`context-mode`](https://pi.dev/packages/context-mode) | Cross-cutting context rewriting can obscure durable tool evidence. |
| [`@hypabolic/pi-hypa`](https://pi.dev/packages/@hypabolic/pi-hypa) | Adds another potentially lossy context-reduction layer. |
| [`pi-rtk-optimizer`](https://pi.dev/packages/pi-rtk-optimizer) | Command rewriting and output truncation conflict with deterministic replay and exact diagnostics. |
| [`pi-memory`](https://pi.dev/packages/pi-memory) | Do not trial two persistent-memory owners; Hermes is the selected candidate. |
| [`pi-goosedump`](https://pi.dev/packages/pi-goosedump) | Session dumping duplicates export/context facilities and is not a memory system. |
| [`pi-goal-list-loop-audit`](https://pi.dev/packages/pi-goal-list-loop-audit) | Duplicates todo, goal, loop, and workflow state machines. |
| [`pi-simplify`](https://pi.dev/packages/pi-simplify) | Simplification belongs in an on-demand skill or review workflow. |
| [`@dietrichgebert/ponytail`](https://pi.dev/packages/@dietrichgebert/ponytail) | Provides guidance rather than an unmet runtime capability. |

## Per-package workflow

1. Pin the exact package version and download its npm tarball or linked repository.
2. Verify source availability, license compatibility, attribution, exports, dependencies, install scripts, and Pi API compatibility.
3. Choose a narrow port into the existing owner or a thin local adapter under `.pi/extensions/<name>/index.ts`.
4. Register the extension and ownership constraints in `.pi/extensions/catalog.json`.
5. Add focused compatibility, cancellation, Windows, and migration tests.
6. Run `pnpm typecheck` and `pnpm test` from `.pi`.
7. Document the adopted version and upstream source in this file, then mark the item complete.