# Workflows Plan

## Goal

Implement Pi workflows as durable, inspectable orchestration runs rather than prompt templates or arbitrary one-off scripts.

A workflow is a trusted or approved JavaScript workflow definition that declares metadata, inputs, budgets, and phases, then executes through a durable runtime API. The runtime persists every phase, step, agent call, artifact, and result outside the main conversation, supports inspection and control, and sends only the final synthesized result back to the conversation.

Core principle:

> A workflow is not just a JavaScript script that happens to call agents. A workflow is a durable execution graph whose nodes may call agents, run phases, checkpoint data, produce artifacts, and return one final result.

Initial bundled workflows should be limited to the workflows that best validate the runtime:

1. **Fan-out and synthesize** - split a task into independent units, run agents in parallel, then synthesize one result.
2. **Deep verification** - extract factual claims from a document and verify them against authoritative sources or the local codebase.

Defer heavier workflow families until the runtime is stable:

- Deep research.
- Generate/filter/tournament.
- Complex parallel editing workflows.

---

## Desired User Experience

### Commands

```text
/workflow
/workflow <workflow-name> <args>
/workflows
```

### `/workflow`

With no args, open a picker containing bundled and saved project workflows.

Picker entries should show:

- workflow name
- description
- trust tier
- expected cost shape: quick, medium, heavy
- whether the workflow can edit files

### `/workflow <workflow-name> <args>`

Run a bundled or saved workflow with the given args.

Example:

```text
/workflow deep-verification workflows-plan.md
```

Before the run starts, Pi shows an approval card:

```text
Workflow: Deep Verification
Input: workflows-plan.md

Plan:
1. Load/extract claims
2. Classify claim source type
3. Verify claims in parallel
4. Double-check disputed/high-impact claims
5. Produce verification report

Budget:
- max agents: 40
- max concurrent: 6
- estimated cost: medium

Actions:
[Run once] [Always allow in this project] [View script] [Cancel]
```

Once approved in the MVP:

- Pi runs the workflow in the foreground and waits for it to finish.
- Progress is streamed/rendered while the run is active.
- `/workflows` can inspect the current run and previous runs.
- The conversation receives only the final result when the workflow completes.

Background execution, where Pi remains available for other conversation turns while a workflow runs, is a later capability for long-running workflows.

### `/workflows`

Show all known workflow runs.

Run list should include:

- run id
- workflow name
- status
- current phase
- agents completed/running/failed
- token and cost totals
- elapsed time
- error summary, if any

Run detail should show:

- input args
- workflow metadata
- phase list
- step list
- agent calls
- artifacts
- final output
- errors
- raw event log, optionally

Users should be able to in the MVP:

- cancel/stop the current foreground run
- resume a stopped run by replaying completed durable steps
- restart failed steps
- view raw workflow source

Later background execution should add pause controls and management of multiple concurrent runs.

---

## Workflow Definition Format

Workflow files should export a structured definition rather than executing top-level arbitrary code.

Example:

```js
export default defineWorkflow({
  name: "deep-verification",
  description: "Extract factual claims from a document and verify them.",

  inputs: {
    document: "string"
  },

  budget: {
    maxAgents: 40,
    maxConcurrent: 6,
    maxTokens: 300000
  },

  capabilities: {
    readsFiles: true,
    editsFiles: false,
    usesWeb: true
  },

  phases: [
    "extract claims",
    "classify claims",
    "verify claims",
    "double-check",
    "report"
  ],

  async run(ctx) {
    const claims = await ctx.step("extract-claims", async () => {
      return ctx.agent({
        key: "extract-claims",
        agent: "explorer",
        prompt: `Extract factual, testable claims from:\n${ctx.args.document}`,
        output: "json"
      });
    });

    const verifications = await ctx.phase("verify claims", async () => {
      return ctx.parallel(claims.items, async (claim, index) => {
        return ctx.agent({
          key: `verify-claim-${claim.id || index}`,
          agent: claim.sourceType === "web" ? "researcher" : "explorer",
          prompt: `Verify this claim and return JSON:\n${JSON.stringify(claim)}`,
          output: "json"
        });
      }, {
        key: "verify-claims",
        concurrency: 6,
        stopOnError: false
      });
    });

    const final = await ctx.step("final-report", async () => {
      return ctx.agent({
        key: "final-report",
        agent: "default",
        prompt: `Write the final verification report:\n${JSON.stringify(verifications)}`
      });
    });

    return final.output;
  }
});
```

Important rules:

- Top-level workflow files declare a workflow; they do not start execution themselves.
- Metadata is explicit and inspectable before approval.
- Budgets are explicit.
- Capabilities are explicit.
- Every durable operation has a stable key.
- Workflow code coordinates only; spawned agents perform reads, writes, commands, web search, fetches, and other tool use.

---

## Durable Step Keys

Stable keys are mandatory for expensive or side-effectful operations.

Bad:

```js
await ctx.agent({ agent: "researcher", prompt });
```

Good:

```js
await ctx.agent({ key: "verify-claim-C12", agent: "researcher", prompt });
```

Stable keys allow the runtime to:

- persist results
- reuse completed work on resume
- skip completed steps when replaying a workflow
- restart failed nodes
- show meaningful run details
- avoid rerunning expensive agents unnecessarily
- make runs debuggable

Resume should be implemented as deterministic replay:

1. Re-run the workflow definition from the beginning.
2. When a durable step key already has a completed result, return the persisted result instead of executing it again.
3. Run missing, failed, stopped, or explicitly restarted steps.

Do not attempt to serialize and restore arbitrary JavaScript continuations.

---

## Sub-agent Communication and Dependencies

Sub-agents should not communicate directly with each other. The workflow runtime is the coordinator and communication layer.

Preferred handoff pattern:

```text
Agent A -> structured result/artifact -> workflow runtime -> Agent B prompt/input
```

Avoid direct agent-to-agent messaging:

```text
Agent A <-> Agent B
```

Direct communication makes workflows harder to debug, replay, resume, inspect, budget, and secure. It also lets agents make coordination decisions that should belong to the workflow definition.

### Structured handoffs

Agents should return structured JSON whenever their output will feed later workflow steps.

Example verification result:

```json
{
  "claimId": "C12",
  "status": "refuted",
  "evidence": [
    {
      "source": "src/runtime.ts:44",
      "summary": "The runtime does not currently support background execution."
    }
  ],
  "confidence": "high"
}
```

The runtime persists this under the agent's durable key and downstream steps consume it explicitly.

### Non-repo information and workflow memory

Sub-agents do not share conversation context with each other. If information is not in the repository, it must be passed through the workflow runtime.

The workflow runtime is the shared memory for a run:

```text
agent output -> persisted result/artifact -> downstream prompt/input
```

For example, in a fan-out-and-synthesize workflow, worker agents return results to the runtime. The runtime stores those results in run state or artifacts, then the workflow explicitly includes selected results, summaries, or artifact references in the synthesis agent's prompt.

Small outputs can be passed directly as JSON in the next prompt. Large outputs should be stored as artifacts and reduced or summarized before synthesis.

Important rule: downstream agents only know information from earlier agents if the workflow explicitly passes it to them.

### Dependency flow

For the MVP, ordinary JavaScript control flow plus stable keys is enough:

```js
const claims = await ctx.agent({ key: "extract-claims", agent: "explorer", output: "json", prompt });

const verifications = await ctx.parallel(claims.items, async (claim) => {
  return ctx.agent({
    key: `verify-${claim.id}`,
    agent: "researcher",
    output: "json",
    prompt: `Verify this claim:\n${JSON.stringify(claim)}`
  });
}, { key: "verify-claims", concurrency: 6 });

const report = await ctx.agent({
  key: "final-report",
  agent: "default",
  prompt: `Write the report from:\n${JSON.stringify(verifications)}`
});
```

This creates an implicit dependency graph:

```text
extract-claims
  -> verify-C1, verify-C2, verify-C3
  -> final-report
```

Later, add optional explicit dependency metadata for smarter invalidation:

```js
await ctx.agent({
  key: "final-report",
  dependsOn: ["verify-C1", "verify-C2", "verify-C3"],
  agent: "default",
  prompt
});
```

If `verify-C2` is restarted, the runtime can mark `final-report` stale and recompute it.

### Artifacts for large handoffs

Do not pass large raw outputs through every prompt. Write large intermediate data as artifacts and pass compact summaries or artifact references downstream.

```js
await ctx.artifact("claims.json", claims);
await ctx.artifact("verification-results.json", verifications);
```

Downstream agents should receive the smallest sufficient context: a compact summary, selected records, or a run artifact path when the receiving agent has read access.

### Reducers between stages

For large fan-out/fan-in workflows, prefer reducer or summarizer stages:

```text
many agents -> structured results -> reducer/summarizer -> next agents
```

This keeps prompts smaller, reduces noise, and makes downstream dependencies clearer.

### Common dependency patterns

- **Sequential dependency**: `A -> B -> C`, implemented with normal `await`.
- **Fan-out/fan-in**: `A -> [B1, B2, B3] -> C`, implemented with `ctx.parallel()` and a synthesis/reducer step.
- **Conditional dependency**: spawn extra verification only for high-impact, surprising, or disputed results.
- **Editing dependency**: worker in worktree -> diff artifact -> reviewer -> explicit integration step.

Workers should not silently merge or overwrite each other's outputs. The workflow should collect, review, and integrate results deliberately.

---

## Runtime API

Expose a context object to workflow `run(ctx)`.

```ts
type AgentName = "default" | "explorer" | "worker" | "researcher" | "guardian" | "judge";

type AgentOutputMode = "text" | "json";

interface WorkflowContext {
  args: unknown;
  runId: string;

  step<T>(
    key: string,
    fn: () => Promise<T>,
    options?: StepOptions
  ): Promise<T>;

  phase<T>(
    name: string,
    fn: () => Promise<T>
  ): Promise<T>;

  agent(options: {
    key: string;
    agent: AgentName;
    prompt: string;
    model?: string;
    output?: AgentOutputMode;
    timeoutMs?: number;
    maxOutputBytes?: number;
    worktree?: boolean | WorktreeOptions;
    metadata?: Record<string, unknown>;
    dependsOn?: string[]; // optional/future explicit dependency metadata
  }): Promise<AgentResult>;

  parallel<T, R>(
    items: T[],
    worker: (item: T, index: number) => Promise<R>,
    options: {
      key: string;
      concurrency?: number;
      stopOnError?: boolean;
    }
  ): Promise<R[]>;

  artifact(path: string, data: string | object): Promise<void>;

  log(message: string, data?: unknown): void;

  fail(message: string): never;
}
```

### `ctx.step(key, fn)`

Runs a durable non-agent step.

- Emits step started/completed/failed events.
- Stores the returned value.
- Reuses the stored value on replay when complete.

### `ctx.phase(name, fn)`

Groups steps and agents into a visible phase.

- Emits phase started/completed/failed events.
- Updates `/workflows` UI.
- Does not itself provide replay unless nested durable steps have keys.

### `ctx.agent(options)`

Starts one subagent through the shared subagent runner.

- Requires `key`.
- Persists prompt, options, output, error, duration, usage, and progress events.
- Reuses completed result on replay.
- Supports text or JSON output parsing.

### `ctx.parallel(items, worker, options)`

Runs mapped work with runtime-controlled concurrency.

- Requires a group `key`.
- Preserves result ordering.
- Respects global and workflow budgets.
- Should not itself hide missing durable keys inside the worker. Agent calls inside the worker still need stable keys.

### `ctx.artifact(path, data)`

Writes workflow artifacts under the run directory, not arbitrary project paths.

Example:

```text
.pi/workflow-runs/<run-id>/artifacts/report.md
.pi/workflow-runs/<run-id>/artifacts/verifications.json
```

---

## Run State and Persistence

Use an append-only event log plus a materialized state summary.

Directory layout:

```text
.pi/workflow-runs/
  <run-id>/
    workflow.js          # snapshot of workflow source used for this run
    input.json           # invocation args
    events.jsonl         # append-only event log
    state.json           # materialized current state for fast UI loading
    artifacts/
      ...
```

`.pi/workflow-runs/` should be gitignored.

### Event examples

```json
{ "type": "run_started", "time": 123, "runId": "run_abc" }
{ "type": "phase_started", "time": 124, "phase": "verify claims" }
{ "type": "agent_started", "time": 125, "key": "verify-claim-C12", "agent": "researcher" }
{ "type": "agent_tool", "time": 126, "key": "verify-claim-C12", "tool": "ddg_search" }
{ "type": "agent_completed", "time": 150, "key": "verify-claim-C12", "usage": { "tokens": 12000 } }
{ "type": "phase_completed", "time": 151, "phase": "verify claims" }
{ "type": "run_completed", "time": 180 }
```

### Materialized state

```ts
interface WorkflowRunState {
  id: string;
  workflowName: string;
  workflowPath?: string;
  sourceSnapshotPath: string;
  args: unknown;
  status: "pending_approval" | "running" | "pausing" | "paused" | "completed" | "failed" | "stopped";
  createdAt: number;
  updatedAt: number;
  phases: WorkflowPhaseState[];
  steps: Record<string, WorkflowStepState>;
  agents: Record<string, WorkflowAgentState>;
  artifacts: WorkflowArtifactState[];
  totals: {
    agentsStarted: number;
    agentsCompleted: number;
    agentsFailed: number;
    tokens: number;
    cost: number;
  };
  finalOutput?: string;
  error?: string;
}
```

Persist after:

- run start
- phase start/end
- step start/end
- agent start/progress/end
- artifact write
- cancel/stop/resume, plus pause once background execution exists
- run completion/failure

---

## Architecture

```text
.pi/extensions/workflows-runtime/
  index.ts
  lib/
    approval.ts          # pre-run approval and approval cache
    commands.ts          # /workflow and /workflows registration
    definition.ts        # defineWorkflow validation and metadata extraction
    registry.ts          # discover bundled and project workflows
    run-store.ts         # event log and materialized state
    runner.ts            # durable execution engine
    scheduler.ts         # concurrency, budgets, cancellation, later background pause/stop
    subagent-runner.ts   # shared execution bridge to tools-subagents
    ui.ts                # list/detail TUI components
  bundled/
    fan-out-and-synthesize.js
    deep-verification.js
```

Data directories:

```text
.pi/workflows/          # project-saved workflows, committed when useful
.pi/workflow-runs/      # local run state, gitignored
.pi/workflow-approvals/ # local approval cache, gitignored
```

Add to `.gitignore`:

```text
.pi/workflow-runs/
.pi/workflow-approvals/
```

---

## Integration With Subagents

Refactor `.pi/extensions/tools-subagents/index.ts` so both the existing `subagent` tool and the workflow runtime call the same implementation.

Shared API should include:

```ts
loadAgents(): AgentConfig[];
runSubagent(options: RunSubagentOptions): Promise<AgentResult>;
runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]>;
```

The shared runner should provide:

- agent discovery from `.pi/extensions/tools-subagents/agents/*.md`
- custom agent registration support
- progress events: started, tool call, tool result, message, completed, failed
- token and cost usage
- output truncation
- cancellation via `AbortSignal`
- optional cwd/worktree support

The public `subagent` tool should become a thin wrapper around this shared runner.

---

## Execution Model

MVP workflows should run in the foreground: the `/workflow` command awaits the run and Pi remains occupied until the workflow finishes, fails, or is cancelled.

This is intentionally simpler than background execution. It avoids early complexity around session lifecycle, final-result injection, multiple concurrent runs, and race conditions with normal user turns.

Starting an MVP workflow should:

1. resolve workflow definition
2. validate args and metadata
3. create run record
4. show approval
5. run the workflow in the current command/turn
6. stream/render progress while it runs
7. persist run state throughout execution
8. return/send the final result when complete

The runtime must still define behavior for:

- user abort/cancel
- TUI mode
- RPC mode
- print/JSON modes without interactive UI
- process shutdown during a foreground run

Cross-process resume can be implemented by replaying the workflow from persisted state when the user explicitly resumes the run.

Background execution should be added later as an explicit mode, for example:

```text
/workflow <name> <args> --background
```

or as an approval-card option:

```text
[Run foreground] [Run in background] [Cancel]
```

A background run should start a managed async task, return control to Pi, update run state while running, and notify/send the final result when complete. That mode must also define behavior for `/reload`, session switch, process shutdown, and multiple concurrent runs.

---

## Cancel, Stop, Pause, Resume, Restart

### MVP cancellation/stop

For foreground workflows, cancellation is the primary control surface.

- Abort running agents.
- Mark run as `stopped`.
- Preserve completed step and agent results.

### Later pause controls

Pause is mainly useful once background execution or a real scheduler exists. Later, support two modes:

1. **Pause after current agents** - do not schedule new work; allow running agents to finish.
2. **Pause now** - abort running agents and mark unfinished work as stopped.

### Resume

- Re-run workflow from the beginning using the original source snapshot and args.
- Skip completed durable steps and agents by key.
- Execute missing/failed/stopped steps.

### Restart failed step/agent

- Mark the selected key as invalidated.
- Resume/replay the workflow.
- Recompute that key and any downstream keys that explicitly depend on it.

For the MVP, downstream invalidation can be manual or conservative. Automatic dependency tracking can be added later.

---

## Trust and Safety Model

Use two trust tiers.

### Tier 1: Bundled trusted workflows

Bundled with the workflow extension.

- Safe to run with normal approval.
- Source is part of the trusted local extension.

### Tier 2: Project workflows

Stored in:

```text
.pi/workflows/*.js
```

Rules:

- Only load when the project is trusted.
- Require first-run approval.
- Allow per-workflow approval cache under `.pi/workflow-approvals/`.
- Snapshot source into the run directory before execution.

Project workflows are trusted project code, similar to project-local Pi extensions. Do not load project workflows unless the project is trusted.

---

## Workflows and File Editing

Editing workflows need an explicit integration model.

Parallel editing agents should generally run in worktrees:

```js
await ctx.agent({
  key: "worker-auth-refactor",
  agent: "worker",
  prompt,
  worktree: {
    branchId: `workflow-${ctx.runId}-auth-refactor`
  }
});
```

Editing agents should return structured output:

```json
{
  "worktree": ".pi/worktrees/workflow-abc-auth-refactor",
  "branch": "fleet/workflow-abc-auth-refactor",
  "filesChanged": ["src/auth.ts"],
  "testsRun": ["pnpm test auth"],
  "diffSummary": "...",
  "risks": []
}
```

Integration must be explicit:

1. collect worker diffs
2. choose accepted diffs
3. apply or merge into the main checkout
4. resolve conflicts
5. run verification
6. cleanup or preserve worktrees

Do not silently merge parallel worker outputs.

If worktrees are unavailable, editing fan-out should either:

- serialize workers, or
- require disjoint file ownership and enforce it.

---

## Bundled Workflow: Fan-out and Synthesize

Use when a task naturally splits into independent subtasks.

Phases:

1. **Plan split** - explorer identifies independent units.
2. **Fan out** - explorer or worker agents execute units in parallel.
3. **Verify** - optional verifier agents check findings or changes.
4. **Synthesize** - final agent produces one answer.

Constraints:

- Splitter must return JSON.
- Each subtask must have a stable id.
- Editing subtasks must declare file ownership or use worktrees.
- Final output should include decisions, files changed, verification, and risks.

Sketch:

```js
export default defineWorkflow({
  name: "fan-out-and-synthesize",
  description: "Split a task into independent subtasks, run agents, then synthesize.",
  budget: { maxAgents: 80, maxConcurrent: 8 },
  phases: ["plan split", "fan out", "synthesize"],

  async run(ctx) {
    const plan = await ctx.agent({
      key: "plan-split",
      agent: "explorer",
      output: "json",
      prompt: `Break this task into independent subtasks. Return JSON only.\n\n${JSON.stringify(ctx.args)}`
    });

    const results = await ctx.phase("fan out", async () => {
      return ctx.parallel(plan.tasks, async (task) => {
        return ctx.agent({
          key: `subtask-${task.id}`,
          agent: task.agent || "worker",
          worktree: task.mayEdit === true,
          output: "json",
          prompt: `Complete this isolated workflow task.\n\nOverall task:\n${JSON.stringify(ctx.args)}\n\nSubtask:\n${JSON.stringify(task)}`
        });
      }, {
        key: "fan-out",
        concurrency: 8,
        stopOnError: false
      });
    });

    const final = await ctx.agent({
      key: "synthesize",
      agent: "default",
      prompt: `Synthesize these results into a concise final response:\n${JSON.stringify(results)}`
    });

    return final.output;
  }
});
```

---

## Bundled Workflow: Deep Verification

Use when a document, report, plan, or claim set must be checked claim by claim.

Pre-run requirement:

- The document text or file path must be provided before the workflow starts.
- No mid-run user input.

Phases:

1. **Load/extract claims** - identify factual, testable claims.
2. **Classify source type** - web, codebase, docs, tests, or mixed.
3. **Verify fan-out** - one verifier per claim.
4. **Adversarial double-check** - second verifier for high-impact, surprising, or disputed claims.
5. **Report** - confirmed, refuted, disputed, unverifiable, with suggested corrections.

Verifier agents should return JSON:

```json
{
  "claimId": "C12",
  "status": "confirmed | refuted | disputed | unverifiable",
  "evidence": [
    { "source": "url-or-file", "summary": "short evidence summary" }
  ],
  "confidence": "high | medium | low",
  "suggestedCorrection": "optional"
}
```

Output requirements:

- Executive summary.
- Claim table.
- Confirmed claims.
- Refuted claims.
- Disputed or unverifiable claims.
- Suggested corrections.
- Source list.
- Confidence labels.

---

## Deferred Workflow Families

### Deep Research

Add after fan-out and deep verification are stable.

Phases:

1. decompose research question
2. search fan-out
3. fetch and extract
4. claim cross-check
5. synthesize cited report

### Generate, Filter, and Tournament

Add after `judge` agent and structured JSON judging are stable.

Phases:

1. confirm rubric before run
2. generate candidates
3. filter
4. dedupe
5. pairwise tournament
6. present winner/ranking/bracket

## Implementation Plan

### Phase 0: Shared Subagent Runner

1. Refactor `tools-subagents` to expose shared runner functions.
2. Keep existing `subagent` tool behavior as a wrapper.
3. Add progress event callbacks suitable for workflow runtime.
4. Add cancellation and output limit support if missing.
5. Add `judge.md` only when tournament workflows are ready.

### Phase 1: Trusted Workflow Runner

1. Create `workflows-runtime` extension.
2. Implement `defineWorkflow` validation.
3. Discover bundled workflows.
4. Implement run creation and source snapshotting.
5. Implement `ctx.phase`, `ctx.step`, `ctx.agent`, `ctx.parallel`, `ctx.artifact`, `ctx.log`, and `ctx.fail`.
6. Persist event log and materialized state.
7. Run trusted bundled workflows only.

### Phase 2: Basic Commands and Approval

1. Register `/workflow`.
2. Register `/workflows` with a simple list/detail view.
3. Implement approval card with view-source support.
4. Support final-result delivery back into the conversation.
5. Add `.gitignore` entries for workflow run/approval state.

### Phase 3: Cancel, Resume, Restart

1. Support cancelling the foreground run.
2. Mark cancelled runs as `stopped` while preserving completed keyed results.
3. Support resume by deterministic replay using durable keys.
4. Support restart failed step/agent.
5. Keep pause-after-current-agents and pause-now as later background/scheduler features.

### Phase 4: Project Workflows

1. Discover `.pi/workflows/*.js` after project trust.
2. Validate project workflow definitions.
3. Add first-run approval.
4. Add approval cache under `.pi/workflow-approvals/`.
5. Invoke saved workflows via `/workflow <name> ...`.

Direct slash commands like `/<workflow-name>` can be added later, or registered at startup/reload only.

### Phase 5: Bundled Workflows

1. Implement fan-out and synthesize.
2. Implement deep verification.
3. Add focused integration tests for both.
4. Tune default budgets and concurrency.

### Phase 6: Editing and Worktree Workflows

1. Integrate optional `tools-worktree` creation.
2. Add structured worktree result collection.
3. Add explicit patch/apply/merge flow.
4. Add conflict handling.
5. Add cleanup/preserve policy.

---

## Safety and Quality Rules

- Workflow code coordinates only; agents perform tool use.
- Every durable operation must have a stable key.
- Public web content and issue text are untrusted.
- Agents that consume untrusted content should not directly perform privileged edits.
- Parallel editing requires worktrees or enforced disjoint file ownership.
- Do not silently merge worktree edits.
- Cap concurrency, total agents, tokens, and cost.
- Persist run state after every meaningful event.
- Prefer official/primary sources in research and verification.
- Mark uncertainty explicitly.
- Do not synthesize unsupported claims into final reports.

---

## Test Plan

### Unit tests

- `defineWorkflow` accepts valid definitions.
- `defineWorkflow` rejects missing name, invalid phases, invalid budget, and missing run function.
- Workflow discovery loads bundled workflows.
- Project discovery ignores project workflows when project is untrusted.
- Workflow names map safely to invocation names.
- Approval cache keys are scoped by project path, workflow name, and source hash.
- Event log appends valid events.
- Materialized state rebuilds from `events.jsonl`.
- `ctx.parallel()` respects concurrency and preserves result ordering.
- Budget enforcement stops before exceeding max agents/tokens.
- Completed keyed steps are reused on replay.
- Failed keyed steps rerun on resume.
- Artifacts can only be written under the run artifact directory.

### Integration tests

- Fan-out workflow runs two explorer agents and synthesizes.
- Deep verification extracts at least one claim and verifies it.
- `/workflow` picker lists bundled workflows.
- `/workflows` shows running, completed, failed, and stopped runs; paused runs are covered once background execution exists.
- Stop aborts running agents and preserves completed results.
- Resume reuses completed agent results.
- Restart failed agent invalidates and reruns selected key.
- Project workflow requires approval on first run.
- Approval cache skips approval only for matching source hash.

### Manual tests

- Start a long foreground workflow, inspect it with `/workflows`, cancel/stop it, then resume it.
- View raw script before approval.
- Run a saved project workflow with args.
- Confirm workflow artifacts are written under `.pi/workflow-runs/<run-id>/artifacts/`.

---

## Open Questions

- Should project workflows support typed input schemas beyond simple metadata?
- Should direct slash commands for saved workflows be startup/reload-only or dynamically registered?
- What is the default local concurrency: current subagent default of 4, or workflow-specific default of 6?
- How should downstream invalidation be represented for restarted steps?
- Should run source snapshots include all imported helper files, or should workflows be limited to single-file definitions initially?
- Should global `~/.pi/workflows/` be supported after project workflows, or deferred until package-level distribution exists?
