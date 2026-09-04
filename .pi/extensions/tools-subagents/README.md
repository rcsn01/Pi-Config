# Tools Subagents

A Pi extension that registers one `subagent` tool and runs specialized agents in isolated child Pi processes.

| Agent | Tools | Purpose |
|---|---|---|
| **default** | read, bash | Small general delegated tasks |
| **explorer** | read, grep, find, ls, repo_query | Read-only codebase investigation |
| **worker** | read, write, edit, safe_bash | Bounded implementation and verification |
| **researcher** | ddg_search, ddg_fetch | Web research and synthesis |
| **judge** | read | Structured rubric-based evaluation |

The researcher uses the local `ddg_search` and `ddg_fetch` extensions. The worker uses the bundled `safe_bash` tool.

## Usage

**Single invocation:**

```json
{
  "tasks": [
    { "agent": "explorer", "task": "Find all auth-related files in src/" }
  ]
}
```

**Parallel invocation:**

```json
{
  "tasks": [
    { "agent": "explorer", "task": "Map the database layer" },
    { "agent": "researcher", "task": "Research connection-pooling best practices" }
  ]
}
```

The tool always accepts one non-empty `tasks` array. One entry runs as a single invocation; multiple entries run in parallel. Legacy `{ "agent", "task", "cwd" }` calls are normalized before validation so stored sessions remain compatible.

Each subagent receives only its task and agent system prompt; it does not inherit the main conversation. Parallel execution defaults to four child processes.

## Batched repository queries

The explorer can use `repo_query` to run independent read-only repository operations in one call:

```json
{
  "operations": [
    { "id": "symbols", "kind": "grep", "pattern": "resolveSubagentAssignment", "path": ".pi/extensions", "glob": "*.ts", "context": 2 },
    { "id": "config", "kind": "read", "path": ".pi/extensions/tools-subagents/config.ts", "offset": 180, "limit": 100 },
    { "id": "agent-files", "kind": "files", "query": "agent" }
  ]
}
```

Supported kinds are `read`, `grep`, `find`, `ls`, `files`, `git_status`, and `git_diff`. A batch has 1-24 operations and runs at most six at a time. Results stay in input order, failed operations are reported beside successful ones, and identical operations within a batch share the first result.

`read` defaults to 200 lines and allows 1,000. `grep` defaults to 50 matches and allows 200, with at most 10 context lines. `find` defaults to 100 results and allows 500. `ls` defaults to 200 entries and allows 500. `files` defaults to 50 results and allows 200. Git operations use fixed status and diff modes and never include untracked file contents.

A `git_diff` operation can limit its output with `paths`:

```json
{
  "operations": [
    {
      "id": "scoped-diff",
      "kind": "git_diff",
      "mode": "uncommitted",
      "paths": ["src/auth", "tests/auth.test.ts"]
    }
  ]
}
```

`git_diff.paths` accepts 1-100 literal file or directory paths relative to the child working directory. It does not support globs or arbitrary Git pathspec syntax. Use path filtering as the follow-up when a complete diff exceeds the output limit.

Paths are resolved against the child working directory. Leading `@` is accepted, but lexical escapes and symlinks that resolve outside the directory are rejected. The tool is read-only, does not run shell commands or arbitrary Git arguments, and has no repository cache. Its complete result is capped at 50KB or 2,000 lines, with every operation header retained when output is truncated.

For investigations, batch two or more independent requests first. Use a later batch only to fill an evidence gap. Keep the direct tools for one-off follow-ups, and do not repeat unchanged searches or excerpts.

## Model and Thinking Configuration

The subagent model and thinking configuration lives in the project-level `settings.json` under a top-level `subagents` key (alongside `compaction` and `uiModelSelector`):

```json
{
  "subagents": {
    "maxConcurrency": 4,
    "defaultModel": "main",
    "agentModels": {
      "worker": "anthropic/claude-sonnet-4-6",
      "researcher": "main"
    },
    "defaultThinkingLevel": "medium",
    "agentThinkingLevels": {
      "worker": "high"
    },
    "defaultContextWindow": 200000,
    "agentContextWindows": {
      "explorer": 131072
    }
  }
}
```

- `maxConcurrency` caps how many child processes run at once (default 4).
- `defaultModel` applies to every agent without an individual model override.
- `agentModels.<agent>` overrides `defaultModel` for that agent.
- `defaultThinkingLevel` applies when an agent has no individual thinking override. Omit it to let Pi choose its default.
- `agentThinkingLevels.<agent>` overrides the global thinking level for that agent.
- `defaultContextWindow` is the intended context window (tokens) for agents without an individual override.
- `agentContextWindows.<agent>` overrides the intended context window for one agent.
- Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; the UI only offers levels supported by the selected model.
- `main` means the main Pi session's active `provider/model` at the moment the child is launched.
- Legacy `default` remains accepted as an alias for `main`.
- A specific model uses canonical `provider/model` syntax, such as `anthropic/claude-sonnet-4-6`.
- Existing `provider/model:thinking` values remain supported and are normalized into separate child `--model` and `--thinking` arguments at launch.
- Missing model configuration ultimately falls back to `main`.
- Empty or malformed settings are configuration errors rather than silent fallbacks.

The configured context window is stored, validated, and shown by `/subagents status` and `/subagents models`. Pi itself derives a child process's actual context window from the model's `contextWindow` in the model catalogue (`models.json`), which defaults to `128000` when a model declares none; pi exposes no per-launch context-window override, so the value here expresses the intended window and must match the underlying model's declared `contextWindow` to be enforced.

Unknown fields inside `subagents` are preserved by slash-command updates. Direct edits to `settings.json` are read on subsequent launches. On first run after upgrading, a legacy `config.json` next to `index.ts` is automatically migrated into the `subagents` key and then deleted.

### Resolution precedence

A launch selects its model in this order:

1. Explicit invocation override, such as a workflow's `ctx.agent({ model: ... })`
2. `agentModels[agentName]`
3. `defaultModel`
4. The agent Markdown frontmatter `model`
5. `main`

This precedence applies to ordinary tool calls, parallel calls, dynamically registered agents, and workflow launches through the shared subagent service.

Thinking is selected independently in this order:

1. An explicit workflow/invocation thinking override
2. Thinking suffix on an explicit invocation model
3. `agentThinkingLevels[agentName]`
4. Thinking suffix on the selected configured model (backward compatibility)
5. `defaultThinkingLevel`
6. Pi's default behavior

### Dynamic `main` behavior

The extension tracks the main model on session start and whenever `/model` changes it. It also checks the current tool context before an ordinary `subagent` call. Therefore, changing the main session model affects subsequently launched agents configured as `main`. An agent that is already running keeps the concrete model selected at its launch.

Only model identity is inherited from `main`. Configure thinking separately in `/subagents`; the main session's current thinking level is not copied automatically.

## Slash Commands

```text
/subagents
/subagents status
/subagents models
/subagents model
/subagents model all main
/subagents model all anthropic/claude-sonnet-4-6
/subagents model worker main
/subagents model worker anthropic/claude-sonnet-4-6
/subagents model worker inherit
/subagents thinking all high
/subagents thinking all default
/subagents thinking worker xhigh
/subagents thinking worker inherit
```

- `/subagents` opens the interactive configuration menu in TUI mode. The first menu shows **All subagents** plus every discovered subagent with its effective model and thinking level.
- Selecting a target opens the searchable model picker, followed by a thinking-level picker tailored to the selected model.
- Individual subagents offer model and thinking **Inherit** choices. **All subagents** offers **Pi default** thinking, which removes explicit thinking overrides.
- After applying both selections, the refreshed menu stays open so more subagents can be adjusted; press Escape to close it. In non-TUI modes, bare `/subagents` falls back to status output.
- `/subagents status` shows discovered agents, tools, missing tool extensions, effective models, and effective thinking levels.
- `/subagents models` shows global and individual model/thinking settings plus every effective assignment.
- `/subagents model` opens the same interactive menu in TUI mode.
- `model all <model>` sets `defaultModel` and clears individual model overrides.
- `model <agent> <model>` creates or replaces one model override; `inherit` removes it.
- `thinking all <level>` sets `defaultThinkingLevel` and clears individual thinking overrides; `default` removes explicit thinking settings.
- `thinking <agent> <level>` creates or replaces one thinking override; `inherit` removes it.

Specific models entered through the command must be present in Pi's authenticated available-model catalogue. Invalid agents and unavailable models do not change the file. Successful changes update the `subagents` key in `settings.json` atomically through Pi's file-mutation queue and take effect without `/reload`.

## Child Pi Selection

Children are started with:

```text
--model <provider/model>
--thinking <level>        # only when explicitly configured
```

`--model` selects the model used by that child. `--thinking` applies the configured thinking level; it is omitted for Pi-default behavior. Pi's separate `--models` option only scopes the catalogue used for model cycling; it does not select the child model.

Child processes use `--no-extensions` and then load only the extensions required by the agent's declared tools. A provider that exists only in an extension not loaded by the child is therefore unavailable even if it appears in the main session.

## UI

`/subagents` opens a three-step configuration UI:

1. Choose **All subagents** or one subagent from a menu displaying each effective model and thinking level.
2. Search and select `main`, an authenticated/scoped `provider/model`, or (for one subagent) `inherit`.
3. Select a thinking level supported by that model, inherit the global setting, or use Pi's default behavior.

The default tool view shows agent status, resolved model, task preview, recent tools, duration, and tokens. Expand the tool result to see the complete task, output, errors, usage, and timing diagnostics. Completed runs split wall time into child startup, model/provider phases, tool execution, and unclassified time. `repo_query` time and query/operation counts appear as a labeled subset of tool time. Concurrent tool intervals count once, so the categories do not exceed total wall time.

Model/provider time includes provider queueing, network latency, and generation. It does not claim to measure hidden reasoning alone. A `~` marker means the child event stream was incomplete, usually after an abort, timeout, or process failure. Timing stays in structured tool details and the visual renderer; it is not appended to the subagent output sent to the main model. The resolved model is recorded before the child's first response event, so progress starts with the intended assignment visible.

## Registering Agents from Other Extensions

Other extensions can register and unregister agents at runtime through the shared service.

### 1. Define an agent

```markdown
---
name: my-agent
description: Does a specific thing
tools: ddg_search
model: main
---

You are an agent that does a specific thing...
```

Frontmatter fields:

- **name** (required): unique tool-facing agent name
- **description**: short status description
- **tools**: comma-separated built-in or mapped extension tools
- **model**: fallback assignment used only when central config does not specify a global or per-agent model

The Markdown body becomes the child system prompt.

### 2. Register through the shared service

```typescript
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getSubagentService } from "../_shared/subagent-service.ts";

const AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

function registerMyAgents(): void {
  const subagents = getSubagentService();
  if (!subagents) return;

  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;

    const tools = (frontmatter.tools || "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);

    try {
      subagents.registerAgent({
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools,
        model: frontmatter.model || "main",
        systemPrompt: body,
        filePath,
      });
    } catch {
      // Already registered.
    }
  }
}
```

The central `agentModels` map resolves dynamically registered agents by name exactly like bundled agents.

### 3. Map custom tools

Custom child tools must be mapped in `CUSTOM_TOOL_EXTENSIONS` in `child-execution.ts`:

```typescript
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  ddg_search: path.join(EXT_BASE, "tools-web-search", "index.ts"),
  ddg_fetch: path.join(EXT_BASE, "tools-web-fetch", "index.ts"),
  safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
};
```

Built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) need no mapping.

## Structure

```text
tools-subagents/
├── index.ts                 # Extension composition and Pi adaptation
├── agent-registry.ts        # Agent discovery, registration, and lookup
├── config.ts                # Configuration storage, validation, and launch resolution
├── launch-preparation.ts    # Agent validation and resolved child requests
├── child-execution.ts       # Child command, process lifetime, observation, abort, and cleanup
├── child-event-ingestion.ts # Stdout framing, event state, usage, timing input, and terminal results
├── subagent-execution.ts    # Direct execution, bounded scheduling, ordered results, and task-state snapshots
├── progress-renderer.ts     # Tool call and progress presentation
├── model-commands.ts        # /subagents command and interactive configuration
├── formatting.ts            # Token, duration, preview, and width formatting
├── test-harness.ts          # Shared focused-test adapters
├── agents/                  # Bundled agent definitions
├── repo-query.ts            # Validation, concurrency, safety, and formatting
└── tools/
    ├── repo-query.ts        # Pi tool adapter
    └── safe-bash.ts         # Restricted child bash extension
```
