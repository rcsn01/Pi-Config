# Pi Extension Improvement Plan

Goal: make the current Pi extension bundle more reliable and closer to the useful parts of Codex CLI without building a second Codex.

Keep it simple:

- Fix broken features before adding new ones.
- Prefer small patches over new frameworks.
- Keep defaults safe.
- Delete or rename features that pretend to do more than they really do.
- Add tests only around behavior that can break safety or core workflows.

## Phase 1: Fix What Is Already Broken

### 1. Fix subagent tool paths

`tools-subagents/index.ts` points to extension directories that do not exist:

- `web-search/index.ts`
- `web-fetch/index.ts`

The repo actually has:

- `tools-web-search/index.ts`
- `tools-web-fetch/index.ts`

Change those paths and remove mappings for missing tools unless the matching extensions are added.

Done when:

- The `researcher` subagent can search and fetch.
- Missing custom tool paths are reported clearly instead of failing later.

### 2. Fix subagent docs

`tools-subagents/README.md` mentions `scout`, but the checked-in agents are:

- `default`
- `explorer`
- `guardian`
- `researcher`
- `worker`

Update the docs to match reality.

Done when:

- README examples use actual agent names.
- The docs do not mention commands or tools that are not implemented.

### 3. Rename or clarify image generation

`tools-image-gen` currently creates placeholder PNG/SVG files with prompt text. It does not perform real model image generation.

Choose one:

- Rename it to placeholder image generation.
- Or clearly say in the tool description that it creates placeholder art.

Do not add a real image backend yet.

Done when:

- Users are not led to expect real image generation.

## Phase 2: Make Defaults Safer

### 4. Stop defaulting sandbox state to full access

`safety-approval-modes/index.ts` initializes sandbox state as `danger-full-access`.

Change the default to:

- `workspace-write` if normal coding tasks should work by default.
- `read-only` if safety is the priority.

Recommendation: use `workspace-write`.

Done when:

- A fresh session is not full access by default.
- `/permissions full-access` or `/sandbox mode danger-full-access` is still available when the user explicitly chooses it.

### 5. Keep command safety simple

Do not build a full policy engine yet.

Improve the existing checks in the smallest useful way:

- Block obvious destructive commands in default mode.
- Ask before network commands.
- Ask before writes outside the workspace.
- Ask before reading obvious secret locations.

Keep the current regex approach for now, but add tests for it.

Done when:

- `rm -rf`, `sudo`, `curl | sh`, network installs, and external writes require approval.
- The behavior is covered by a small test file.

### 6. Add a tiny approval retry

Codex has `/approve`; Pi can add a simple version.

Implement:

- Store the last denied command/tool action.
- `/approve` retries only that one action once.
- Do not add persistent approval rules yet.

Done when:

- A user can recover from one false-positive denial without switching to full access.

## Phase 3: Add Only High-Value Codex-Like Features

### 7. Add a basic `/status`

This is more useful than many advanced features.

Show:

- cwd
- active model if available
- permission mode
- sandbox mode
- active todo count
- active goal
- active subagent count if available

Done when:

- A user can understand the current session state from one command.

### 8. Improve `/review`, but keep it local

Do not add a new reviewer service.

Improve the current review tool:

- Include staged, unstaged, and untracked files.
- Put findings first.
- Sort by severity.
- Say clearly when diff content was truncated.

Done when:

- `/review uncommitted` gives actionable findings and does not silently hide major omitted diff content.

### 9. Add minimal subagent status

Do not rebuild Codex thread management.

Add just enough:

- list available agents
- list configured tools for each agent
- show whether custom tool extension paths exist
- show max concurrency

Done when:

- Users can debug subagent setup without reading TypeScript.

## Phase 4: Defer Larger Systems

Do not build these yet:

- MCP support
- plugin marketplace
- full Codex-compatible skills system
- hook trust system
- remote app server
- background terminal manager
- custom permission profile language
- full session resume/fork engine

These are useful, but they are large systems. Add them only after the existing extension bundle is reliable and there is a clear need.

## Immediate Task List

1. Patch subagent custom tool paths.
2. Update subagent README to match actual agents.
3. Change default sandbox state to `workspace-write`.
4. Clarify image generation as placeholder generation.
5. Add small tests for command/path safety helpers.
6. Add `/status`.
7. Add minimal `/subagents status`.

## Non-Goals

- Do not chase exact Codex parity.
- Do not add a new config format unless the current one blocks progress.
- Do not create a plugin system before the built-in extensions are stable.
- Do not add real image generation until there is a chosen backend and a clear user need.
- Do not replace Pi internals from extensions unless the runtime explicitly supports it.
