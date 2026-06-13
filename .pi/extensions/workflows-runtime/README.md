# Workflows Runtime

Durable workflows are approved JavaScript definitions that coordinate phases, durable steps, subagents, parallel blocks, artifacts, and one final result.

## Commands

```text
/workflow
/workflow list
/workflow <workflow-name> <args>
/workflow background <workflow-name> <args>
/workflow resume <run-id>
/workflow restart <run-id> <durable-key>
/workflow stop <run-id>
/workflow pause <run-id>
/workflow pause-now <run-id>
/workflow source <workflow-name|run-id>
/workflow integrate <run-id> <agent-key>
/workflow cleanup-worktrees <run-id>

/workflows
/workflows <run-id>
/workflows raw <run-id>
```

Foreground workflows occupy the current Pi command until completion. Background workflows are in-process only; they do not continue after Pi exits. Resume is deterministic replay from persisted state and the workflow source snapshot.

## Authoring Workflows

Project workflows live in `.pi/workflows/*.js|*.mjs|*.ts` and export a definition:

```ts
import { defineWorkflow } from "../extensions/workflows-runtime/index.ts";

export default defineWorkflow({
  name: "my-workflow",
  description: "What it does.",
  budget: { maxAgents: 10, maxConcurrent: 3, maxTokens: 100000, estimatedCost: "medium" },
  capabilities: { canEditFiles: false, usesWeb: true },
  phases: ["plan", "run", "report"],
  async run(ctx) {
    const data = await ctx.agent({ key: "collect-data", agent: "researcher", output: "json", prompt: "..." });
    await ctx.artifact("data.json", data);
    return ctx.agent({ key: "final-report", agent: "default", prompt: JSON.stringify(data) });
  }
});
```

Rules:

- Workflow names are kebab-case and must match the project workflow filename.
- Capabilities or `canEditFiles` must be explicit.
- Budgets should be explicit for agent-heavy workflows.
- Every expensive or side-effectful operation needs a stable durable key.
- Workflow code coordinates only; subagents perform file, command, and web work.

## Durable Keys and Replay

`ctx.step()` and `ctx.agent()` persist completed results by key. On resume, the workflow is re-run from the beginning and completed keys return persisted values instead of executing again. Failed, stopped, missing, or invalidated keys rerun.

`dependsOn` can declare downstream dependencies. `/workflow restart <run-id> <key>` invalidates the selected key and any keys projected from explicit dependency events.

## Trust Model

- Bundled workflows are trusted extension code.
- Project workflows are discovered as metadata only before approval.
- Project workflows require approval keyed by project path hash, workflow name, and source hash.
- The runtime snapshots source into `.pi/workflow-runs/<run-id>/source.*` before importing and replaying.
- Source hash changes require approval again.

## Run Directory Layout

```text
.pi/workflow-runs/<run-id>/
  source.*
  input.json
  events.jsonl
  state.json
  artifacts/
```

`state.json` is a materialized projection of the append-only event log and is written atomically.

## Background, Pause, Stop, Resume

Background execution is managed in the current Pi process. Active background runs update the same event log and can be inspected with `/workflows`.

- `stop` aborts running agents and marks the run stopped.
- `pause` requests pause after current scheduled work reaches the next scheduling boundary.
- `pause-now` aborts now and leaves replayable state.
- `resume` replays from the source snapshot and skips completed keys.

## Worktree Editing Safety

`ctx.agent({ worktree: true })` creates `.pi/worktrees/workflow-<runId>-<key>` on branch `fleet/<branch-id>` and runs the worker there. The runtime stores diff artifacts under `artifacts/diffs/`.

No workflow silently merges worktree changes. Use:

```text
/workflow integrate <run-id> <agent-key>
```

to apply a stored patch to the main checkout after `git apply --check`. Review, test, and commit manually. Cleanup is explicit with `/workflow cleanup-worktrees <run-id>` and skips dirty worktrees.

## Bundled Workflows

- `fan-out-and-synthesize`: split independent tasks, run agents, optionally verify, synthesize.
- `deep-verification`: extract and verify claims from a file/text/topic.
- `deep-research`: decompose a research question, search/fetch, cross-check, produce cited report.
- `generate-filter-tournament`: generate candidates, filter/dedupe, judge pairwise, rank.
