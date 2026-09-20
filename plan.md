# Implementation plan: return verdicts from Permission classification

## Outcome

The Permission classification module (`policy-permissions/permission-policy.ts`) stops being interaction code and becomes a pure, synchronous verdict function: `classifyToolCall(input, ctx)` returns an **ordered list of verdict steps** — block decisions and interaction asks (user prompts, Guardian reviews) as data, with every prompt title, message, denial record, and declined-reason policy attached to the step that owns it. The Permission enforcement lifecycle deletes the `EvaluateDeps` callback interface, keeps its own adapter seam (`requestUserConfirmation`, `runGuardianReview`, `persistGuardianVerdict`) byte-identical, and gains one step-resolution loop that performs every effect through its existing helpers.

What this buys:

- **Depth moves to the classifier.** Check ordering — currently scattered across ten await-and-deny sites (eight `deps.requestApproval`, two `deps.guardianReview`, each followed by `if (!allowed) { deps.onDenied(...); return block }`) — becomes precomputable data from `(input, mode, cwd, execPolicy)`. Asking "what happens for this tool call in this mode?" is answered by reading one array, not by executing code.
- **The ask-block-ask problem dies.** Today a bash command with an execpolicy prompt rule and a malformed snapshot-helper invocation produces prompt → block → (unreachable) prompt in *procedural* order that no one can see. The verdict encodes the order explicitly: `[execpolicy-ask, wrapper-block, guardian-ask]` — the wrapper block visibly preempts the Guardian ask.
- **The classifier becomes testable without a stub harness.** Today `permission-policy.test.ts` maintains an `EvaluateDeps` stub + a lifecycle-wrapping helper purely to drive interaction. The verdict interface needs no stubs: golden step arrays.
- **`EvaluateDeps` and `PermissionDecision` are deleted.** `EvaluateDeps` has exactly one real adapter (the lifecycle) — a hypothetical seam. `PermissionDecision`'s `{action: "allow" | "block"}` no longer describes the verdict.

Out of scope (unchanged): Guardian execution and verdict-protocol separation (candidate 5), path-policy, mode-registry, approvals.ts, guardian-runner, command-policy, and the lifecycle adapter interface.

## Resolved design decisions

Design-it-twice ran three independent designers over this seam. All three converged on "the classifier returns a precomputed plan; the lifecycle resolves it." The deltas were the verdict shape and how much metadata each step carries:

- **Designer 1** — verdict with interleaved `ask | block` steps, resolved in order, empty = allow.
- **Designer 2** — full `PermissionPlan` with per-step `site` ids, `fixed`/`fallback` denied-reason union, `ask | block` steps.
- **Designer 3** — `asks` array plus a single terminal `block` field ("every pure block precedes all asks").

Designer 3's shape was **rejected on verified reachability**: a terminal block after all asks cannot encode today's reachable sequences. Three proofs, all from current source order:

1. `bash` + read-only mode + an execpolicy prompt rule (execpolicy runs in *all* modes, before mode checks) → prompt first, then the read-only write-tool block: ask-then-block.
2. `bash` + default + execpolicy prompt rule + a malformed snapshot-helper invocation → `[execpolicy-ask, wrapper-block, network-ask]`: a malformed helper invocation is always also a network command (`isNetworkCommand` returns true for it), so the default-mode network ask sits after the wrapper block — ask-block-ask with a user ask.
3. Same in auto-review → `[execpolicy-ask, wrapper-block, guardian-command-review]`: ask-block-ask.

Only an ordered interleaved step list encodes these. Designer 2's `site` ids were rejected on YAGNI (no consumer exists; verdict auditing is speculative) — it would be the first field to add if one ever arrives. Its `fixed`/`fallback` denied-reason union was **adopted**: each site is exactly one flavor, so the exception is encoded as data instead of a lifecycle-side special case.

The remaining decisions, grilling-style with self-answered recommendations:

### 1. Seam placement: verdict protocol; the lifecycle's own seam is untouched

The classifier's `EvaluateDeps` seam is deleted. The lifecycle's adapter seam (`requestUserConfirmation`, `runGuardianReview`, `persistGuardianVerdict`) does not change — that seam has three real implementations (the Pi host and two test harnesses: the lifecycle suite and the classifier suite's lifecycle-wrapping helper); the deleted seam had one real implementation (the lifecycle itself) plus a test-only stub. CONTEXT.md already assigns effects to the lifecycle and classification to permission-policy; this change makes the code agree with the map.

### 2. Verdict shape: ordered `PermissionStep` list; empty list = allow

`classifyToolCall` returns `readonly PermissionStep[]`. Resolution contract (lifecycle-owned): steps resolve in order; the first denied ask short-circuits with a block; a block step terminates immediately; an empty list means allowed by policy. No top-level verdict wrapper — an array with a documented empty-case invariant is the minimal interface that still encodes ordering.

### 3. Denied-reason encoding: per-step `{kind: "fixed"} | {kind: "fallback"}` union

```ts
declinedReason: { kind: "fixed"; reason: string } | { kind: "fallback"; reason: string }
```

Lifecycle resolution: `fixed ? step reason : (result.reason ?? step reason)`. Exactly one site uses `fixed` (execpolicy ignores the approval result's reason today: `"User declined via execpolicy prompt."` is unconditional). All other sites use `fallback` — carried even though every current lifecycle denial path produces a reason (`"User declined."`, the disposition's decided reason, `result.reason || "Guardian denied."`, the guardian-fallback reason), because the fallback is the classifier's site-level parity data and keeps the verdict total. Rejected alternatives: two optional fields (implies both can co-exist — they cannot), lifecycle-side execpolicy special case (scatters parity data out of the classifier).

### 4. Denial records: per-step `denial: {title, message}`; lifecycle keeps the gating

The `onDenied` record (drives `/approve` last-denied state) differs from the prompt at several sites — the execpolicy denial title is always `"Execpolicy Check"` even when the prompt title is `"Execpolicy - Default Prompt"`, denial messages truncate/slice differently (`command.slice(0, 200)` vs. the full review message), and the auto-review external-write denial records only the first external path. All divergences are tabled below and pinned by tests. The lifecycle keeps `hasUI` + `authorizationGeneration` gating, `promptedDenial` tracking, and `approvable: promptedDenial` exactly as today.

### 5. Naming and home: deepen in place

File stays `permission-policy.ts`; `evaluateToolCall` → `classifyToolCall` (async → sync; the async-ness existed only for the awaits). Types live in `policy-types.ts`: delete `EvaluateDeps` + `PermissionDecision`; add `PermissionStep` (`PermissionAsk | PermissionBlock`) and `DeclinedReason`; keep `ToolCallInput`, `EvaluateContext` (including `hasUI` — the execpolicy no-UI fail-closed block is a classification decision, not an effect), and `ApprovalResult` (shared with guardian-runner and the lifecycle helpers).

### 6. index.ts backward-compat re-export: deleted

`export { permissionActionKey as actionKey, evaluateToolCall }` (index.ts:62) has zero consumers: no file imports these names from `index`, and `index.test.ts` pins nothing about them. Delete the re-export, the `evaluateToolCall` import (index.ts:55), and the `permissionActionKey` entry in the lifecycle import (index.ts:49 — no internal use either). `permissionActionKey` remains exported from the lifecycle for its tests.

### 7. Test strategy: replace, don't layer

Per DEEPENING.md, tests move to the deepened interface; the old stub-harness tests are deleted, not layered beside the new ones:

- `permission-policy.test.ts` — **rewritten** as pure `classifyToolCall` assertions: golden step arrays. No lifecycle, no `EvaluateDeps` stubs. Includes the new ordering cases (multi-ask order, ask-then-block, ask-block-ask) that the interaction harness could not see.
- `permission-enforcement-lifecycle.test.ts` — **kept, must pass unchanged** (the parity proof: 19 tests — 17 over the adapter-stub harness, 16 `it` declarations with one `it.each` × 2, plus 2 `permissionActionKey` tests). Plus 3 new cases for step-walk specifics the classifier tests cannot cover (reason passthrough, short-circuit, ask-then-block effects).

### 8. Scope guards

Guardian execution/verdict-protocol separation (candidate 5) stays out. path-policy, mode-registry, approvals.ts, guardian-runner, command-policy are untouched. The lifecycle adapter interface is unchanged. The execpolicy prompt message already ends `\n\nProceed?` and the lifecycle appends another `\n\nProceed?` — a pre-existing quirk, **carried verbatim** (noted below; fixing it would change observable prompt text and is out of scope).

### 9. CONTEXT.md at decision time (done)

The Safety section now carries the decision — new **Permission classification module** entry, and the **Permission enforcement lifecycle** entry sharpened ("check ordering is data owned by the Permission classification module"; the lifecycle owns verdict resolution and transient-approval state).

### 10. YAGNI cuts

Agent 2's `site` ids on steps: dropped — no consumer. `DeclinedReason`'s two-variant union: kept — justified by execpolicy parity (fixed) vs. the nine result-derived sites (fallback).

## Current evidence and friction

All line refs verified against the working tree (HEAD `83632c4`, clean except this plan rewrite and the CONTEXT.md decision-time edits).

### Where the interaction machinery lives

| Location | Lines | What |
|---|---|---|
| `permission-policy.ts` | 1–7 | Header: "Pure permission classification… lifecycle owns its ordering, side effects, and state" (the header already states the target design; the code doesn't deliver it) |
| `permission-policy.ts` | 28 | `import type { EvaluateContext, EvaluateDeps, PermissionDecision, ToolCallInput }` |
| `permission-policy.ts` | 46–294 | `evaluateToolCall(input, ctx, deps)` — async, interaction-capable |
| `permission-policy.ts` | 67, 72 | execpolicy: `deps.requestApproval` + `onDenied` |
| `permission-policy.ts` | 120, 122 | sensitive path |
| `permission-policy.ts` | 185, 187 | Guardian command review |
| `permission-policy.ts` | 194, 199 | dangerous command |
| `permission-policy.ts` | 204, 209 | network command |
| `permission-policy.ts` | 214, 219 | snapshot removal |
| `permission-policy.ts` | 229, 234 | network tool |
| `permission-policy.ts` | 258, 260 | Guardian external write |
| `permission-policy.ts` | 268, 273, 280, 285 | external path (both variants) |
| `permission-enforcement-lifecycle.ts` | 112 | `permissionActionKey` |
| `permission-enforcement-lifecycle.ts` | 127–145 | `requestApproval` helper: disposition consult, `\n\nProceed?` append, prompt-deny reason `"User declined."` |
| `permission-enforcement-lifecycle.ts` | 147–187 | `guardianReview` helper: no-UI reason, evidence build, `persistGuardianVerdict`, `"Guardian denied."` fallback, user fallback on throw |
| `permission-enforcement-lifecycle.ts` | 220–258 | `evaluate()`: one-shot check (222), mode/generation capture (224–225), `promptedDenial` (226), `allowedSource` (227–230), `evaluateToolCall` call (231–255), `onDenied` gate (245–246), decision handling (256–258) |
| `policy-types.ts` | 8–10 | `PermissionDecision` |
| `policy-types.ts` | 13–16, 19–24, 27–30 | `ToolCallInput`, `EvaluateContext`, `ApprovalResult` (keep) |
| `policy-types.ts` | 33–40 | `EvaluateDeps` |
| `index.ts` | 49, 55, 62 | `permissionActionKey` import, `evaluateToolCall` import, backward-compat re-export |

### Consumer audit (verified)

- `EvaluateDeps`, `PermissionDecision`: imported only by `permission-policy.ts`, `permission-policy.test.ts`, and defined in `policy-types.ts`. No other consumers.
- `ApprovalResult`: also used by `permission-enforcement-lifecycle.ts` (helper return type), `guardian-runner.ts` (`GuardianReviewResult extends ApprovalResult`), and `permission-policy.test.ts`. **Keep.**
- `evaluateToolCall`: used only by the lifecycle (line 231), its own test, and index.ts (import + re-export). The re-export has zero consumers.
- `permissionActionKey`: used by the lifecycle internally and its test; index.ts only imports-and-re-exports it.

### Test evidence (verified)

- `permission-policy.test.ts` drives classification through a helper that wraps `evaluateToolCall` with an `EvaluateDeps` stub (`requestApproval` resolving per an `approve` flag, `onDenied` recording) — a harness that exists only because the classifier demands interaction callbacks. 28 tests exercising 37 classify invocations (32 source call sites; two of them loop over multiple commands or modes, adding 5 invocations).
- `permission-enforcement-lifecycle.test.ts`: 19 tests — 17 over `createPermissionEnforcementLifecycle(adapter, { now: () => 42 })` with `synchronizeSession({cwd: "/workspace", resetTransientApprovals: true})` (16 `it` declarations, one `it.each` × 2) plus 2 `permissionActionKey` tests; pins verdict persistence shape `{allowed, reason, model, title, triggers}`, no-UI guardian never calling `runGuardianReview`, in-flight mode snapshot (allowed source `"user"` despite mid-flight `changeMode`), generation-gated denial across mode change, last-denied clearing on static block.

### Reachable-sequence proofs (source-order facts)

- Execpolicy runs for bash in **all** modes, before every mode check (lines 54–77).
- Read-only checks run after execpolicy (lines 80–112) and before the bash block (129+): read-only bash with an execpolicy prompt rule ⇒ ask-then-block.
- Default/auto-review bash: wrapper block (138–144) sits between the execpolicy ask and the dangerous/network/snapshot asks or the Guardian review ⇒ observably ask-then-block; the verdict encodes ask-block-ask (the trailing asks are dead steps once the block short-circuits).
- Every lifecycle denial path yields a reason: prompt-deny → `"User declined."` (lifecycle 141–143), decided disposition → the mode's reason, guardian → `result.reason || "Guardian denied."` (lifecycle 174), guardian fallback → fixed reason (lifecycle 183–185). The nine site fallbacks are therefore shadowed in production today; execpolicy's `fixed` reason is the observable one.

### Friction summary

1. The classifier is async interaction code: untestable without a stub harness; ten copies of the same await/deny/return shape.
2. `EvaluateDeps` is a one-adapter seam — an interface with no second implementation and no host variation.
3. Check ordering is procedural; the verdict data (titles, denial records, reasons, triggers) is embedded in control flow.
4. The test stub harness is pure ceremony created by the deps seam.

## Target implementation

### Module interface: `policy-permissions/policy-types.ts` (rewritten)

```ts
/**
 * Shared verdict and context types for the Safety Permissions extension.
 */
import type { ExecPolicyConfig } from "../_shared/command-policy.ts";
import type { ApprovalMode } from "./mode-registry.ts";

/** Why a denied ask blocks: fixed classifier text, or the approval result's reason with a site fallback. */
export type DeclinedReason =
	| { kind: "fixed"; reason: string }
	| { kind: "fallback"; reason: string };

/** An interaction ask (user prompt or Guardian review) as verdict data. */
export interface PermissionAsk {
	kind: "ask";
	/** Which lifecycle resolver handles the ask. */
	channel: "user" | "guardian";
	/** Prompt or review title and body, verbatim. */
	title: string;
	message: string;
	/** Guardian triggers; guardian asks carry non-empty triggers. */
	triggers?: readonly string[];
	/** What the lifecycle records on denial (differs from the prompt at several sites). */
	denial: { title: string; message: string };
	/** The block reason when the ask is denied. */
	declinedReason: DeclinedReason;
}

/** An unconditional block decision as verdict data. */
export interface PermissionBlock {
	kind: "block";
	reason: string;
}

/**
 * One ordered verdict step: steps resolve in order; the first denied ask
 * short-circuits with a block; a block step terminates; an empty list = allow.
 */
export type PermissionStep = PermissionAsk | PermissionBlock;

/** The tool call being classified. */
export interface ToolCallInput {
	toolName: string;
	input: unknown;
}

/** Read-only inputs to classification — precomputable, no interaction, no mutable state. */
export interface EvaluateContext {
	mode: ApprovalMode;
	cwd: string;
	hasUI: boolean;
	execPolicy: ExecPolicyConfig;
}

/** Result of a user/Guardian approval flow. */
export interface ApprovalResult {
	allowed: boolean;
	reason?: string;
}
```

`EvaluateDeps` and `PermissionDecision` are gone. `ApprovalResult` stays (guardian-runner + lifecycle helpers).

### Permission classification: `policy-permissions/permission-policy.ts` (rewritten)

A pure transformation of the current file: every `await deps.X(...); if (!allowed) { deps.onDenied(...); return block }` becomes `steps.push(askStep)` / `steps.push(blockStep)`; every `return {action: "block"}` becomes a pushed block step; `return {action: "allow"}` becomes `return steps` (empty). Check order, mode gates, message text, truncations, and denial-record divergences are byte-preserved.

```ts
/**
 * Pure permission classification for the Safety Permissions extension.
 *
 * `classifyToolCall` classifies one tool call for the current mode into an
 * ordered verdict: block decisions and interaction asks (user prompts, Guardian
 * reviews) as data. It performs no interaction — the permission enforcement
 * lifecycle resolves asks through its adapter seam, in order, short-circuiting
 * on the first denial. Verdicts are precomputable from
 * (input, mode, cwd, execPolicy); the execpolicy no-UI fail-closed block stays
 * classification-side.
 */
import {
	dangerousShellReason,
	evaluateExecPolicy,
	extractExternalPathsFromCommand,
	githubRepositorySnapshotOperation,
	isNetworkCommand,
	isNetworkToolName,
	isReadOnlyShellCommand,
	mentionsGithubRepositorySnapshotHelper,
} from "../_shared/command-policy.ts";
import {
	ALL_PATH_TOOLS,
	PATH_READ_TOOLS,
	WRITE_TOOLS,
	extractPathsFromInput,
	isExternalWritePath,
	isPathWithinCwd,
	isSensitivePath,
	resolveToolPath,
} from "./path-policy.ts";
import type { EvaluateContext, PermissionAsk, PermissionStep, ToolCallInput } from "./policy-types.ts";

function commandOf(input: ToolCallInput): string {
	return (input.input && typeof input.input === "object"
		? (input.input as Record<string, unknown>).command
		: undefined) as string | undefined ?? "";
}

/** User prompt: the denial record titles with the prompt; the reason comes from the approval result. */
function userAsk(
	title: string,
	message: string,
	denialMessage: string,
	fallback: string,
): PermissionAsk {
	return {
		kind: "ask",
		channel: "user",
		title,
		message,
		denial: { title, message: denialMessage },
		declinedReason: { kind: "fallback", reason: fallback },
	};
}

/** Guardian review: triggers travel with the ask; the denial record may differ from the prompt. */
function guardianAsk(
	title: string,
	message: string,
	triggers: readonly string[],
	denialTitle: string,
	denialMessage: string,
	fallback: string,
): PermissionAsk {
	return {
		kind: "ask",
		channel: "guardian",
		title,
		message,
		triggers,
		denial: { title: denialTitle, message: denialMessage },
		declinedReason: { kind: "fallback", reason: fallback },
	};
}

/**
 * Classify a tool call into an ordered verdict. Empty list = allowed by policy.
 * Order of checks preserved from the original handler:
 *  1. execpolicy (bash, all modes)
 *  2. read-only: block write/network tools + path containment
 *  3. default: sensitive-path reads
 *  4. bash: read-only-command check + dangerous/network/external-path
 *  5. default: network tools
 *  6. default/auto-review: external path writes
 */
export function classifyToolCall(
	input: ToolCallInput,
	ctx: EvaluateContext,
): readonly PermissionStep[] {
	const steps: PermissionStep[] = [];
	const { toolName } = input;
	const { mode, cwd, hasUI, execPolicy } = ctx;

	// ── ExecPolicy check (bash only, all modes) ────────────────────
	if (toolName === "bash") {
		const command = commandOf(input);
		const policy = evaluateExecPolicy(command, execPolicy);
		if (policy.matched || execPolicy.defaultAction !== "allow") {
			if (policy.action === "block") {
				steps.push({
					kind: "block",
					reason: `Execpolicy blocked: ${policy.rule?.reason || "default block"}`,
				});
			} else if (policy.action === "prompt") {
				if (!hasUI) {
					steps.push({
						kind: "block",
						reason: `Execpolicy requires prompt: ${policy.rule?.reason || "default prompt"}`,
					});
				} else {
					steps.push({
						kind: "ask",
						channel: "user",
						title: policy.matched ? "Execpolicy Check" : "Execpolicy - Default Prompt",
						message: `${policy.matched ? `Rule matched: ${policy.rule?.reason || policy.rule?.pattern}` : "No allow rule matched; default action is prompt."}\n\nCommand: ${command.slice(0, 200)}\n\nProceed?`,
						denial: { title: "Execpolicy Check", message: command.slice(0, 200) },
						declinedReason: { kind: "fixed", reason: "User declined via execpolicy prompt." },
					});
				}
			}
		}
	}

	// ── Read-only mode: block mutations ────────────────────────────
	if (mode === "read-only") {
		const readOnlySnapshotOperation = toolName === "bash" ? githubRepositorySnapshotOperation(commandOf(input)) : undefined;

		// Block write/mutating tools entirely. Snapshot listing is a read-only
		// helper command even though it runs through the built-in bash tool.
		if (WRITE_TOOLS.has(toolName) && !(toolName === "bash" && readOnlySnapshotOperation === "list")) {
			steps.push({
				kind: "block",
				reason: `Approval mode is read-only. Tool \`${toolName}\` is blocked. Use /permissions default to allow modifications.`,
			});
		}

		// Block network tools
		if (isNetworkToolName(toolName)) {
			steps.push({
				kind: "block",
				reason: `Approval mode is read-only. Network tool \`${toolName}\` is blocked.`,
			});
		}

		// Restrict path-based read tools to cwd only
		if (ALL_PATH_TOOLS.has(toolName)) {
			const inputPaths = extractPathsFromInput(toolName, input.input);
			for (const inputPath of inputPaths) {
				if (!isPathWithinCwd(inputPath, cwd)) {
					steps.push({
						kind: "block",
						reason: `Read-only mode: path "${inputPath}" is outside current directory (${cwd}). Only paths within the workspace are accessible.`,
					});
				}
			}
		}
	}

	// ── Sensitive path reads for default ───────────────────────────
	if (mode === "default" && PATH_READ_TOOLS.has(toolName)) {
		const inputPaths = extractPathsFromInput(toolName, input.input);
		for (const inputPath of inputPaths) {
			if (inputPath && isSensitivePath(inputPath)) {
				const message = `Tool \`${toolName}\` appears to read a sensitive path.\n\nPath: ${inputPath}`;
				steps.push(userAsk("Sensitive Path", message, message, "Sensitive path access blocked."));
			}
		}
	}

	// ── Bash-specific checks across modes ──────────────────────────
	if (toolName === "bash") {
		const command = commandOf(input);
		const trimmedCmd = command.trim();
		const snapshotOperation = githubRepositorySnapshotOperation(trimmedCmd);
		const mentionsSnapshotHelper = mentionsGithubRepositorySnapshotHelper(trimmedCmd);

		// Do not let wrappers, aliases, path variants, or compound commands
		// bypass the helper's network/removal classifications.
		if ((mode === "default" || mode === "auto-review") && mentionsSnapshotHelper && !snapshotOperation) {
			steps.push({
				kind: "block",
				reason: "Unrecognized GitHub snapshot helper command. Use the exact command shown by the github-repo-explorer skill.",
			});
		}

		// Read-only bash: only read-only commands allowed
		if (mode === "read-only" && !isReadOnlyShellCommand(trimmedCmd)) {
			steps.push({
				kind: "block",
				reason: `Approval mode is read-only. Command blocked: ${trimmedCmd.slice(0, 80)}. Use /permissions default to allow writes.`,
			});
		}

		// Default & auto-review: dangerous commands need approval
		if (mode === "default" || mode === "auto-review") {
			const dangerReason = dangerousShellReason(trimmedCmd);
			const network = isNetworkCommand(trimmedCmd);
			const externalPaths = mode === "auto-review"
				? extractExternalPathsFromCommand(trimmedCmd, cwd)
				: [];

			if (mode === "auto-review") {
				// Batch every concern into ONE guardian review per command.
				const triggers: string[] = [];
				const concerns: string[] = [];
				if (dangerReason) {
					triggers.push("dangerous");
					concerns.push(`- Dangerous: ${dangerReason}`);
				}
				if (network) {
					triggers.push("network");
					concerns.push("- Network: command may install/modify software outside the workspace");
				}
				if (snapshotOperation === "remove") {
					triggers.push("repository-snapshot-removal");
					concerns.push("- Repository snapshot removal: deletes a stored source snapshot");
				}
				if (externalPaths.length > 0) {
					triggers.push("external-path");
					const pathList = externalPaths.slice(0, 5).map((p) => `  - ${p}`).join("\n");
					const extra = externalPaths.length > 5 ? `\n  ... and ${externalPaths.length - 5} more` : "";
					concerns.push(`- External paths (outside workspace):\n${pathList}${extra}`);
				}
				if (triggers.length > 0) {
					const message = `Command: ${trimmedCmd}\n\nConcerns:\n${concerns.join("\n")}`;
					steps.push(guardianAsk("Command Review", message, triggers, "Command Review", message, "Auto-review: command blocked."));
				}
			} else {
				// Default mode: per-trigger user prompts (unchanged)
				if (dangerReason) {
					steps.push(userAsk(
						"Dangerous Command",
						`Default mode detected: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						trimmedCmd.slice(0, 200),
						"Blocked.",
					));
				}
				if (network) {
					steps.push(userAsk(
						"Network Access",
						`Command appears to require network access.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						trimmedCmd.slice(0, 200),
						"Network access blocked.",
					));
				}
				if (snapshotOperation === "remove") {
					steps.push(userAsk(
						"Repository Snapshot Removal",
						`This command deletes a stored repository source snapshot.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						trimmedCmd.slice(0, 200),
						"Repository snapshot removal blocked.",
					));
				}
			}
		}
	}

	// ── Network tool checks for default ────────────────────────────
	if (mode === "default" && isNetworkToolName(toolName)) {
		const message = `Tool \`${toolName}\` requires network access.`;
		steps.push(userAsk("Network Tool", message, message, "Network access blocked."));
	}

	// ── External path writes for default / auto-review ─────────────
	if ((mode === "default" || mode === "auto-review") &&
		(toolName === "write" || toolName === "edit")) {
		const inputPaths = extractPathsFromInput(toolName, input.input);

		if (mode === "auto-review") {
			// Batch every external path into ONE guardian review per tool call.
			const externalWrites: Array<{ path: string; detail: string }> = [];
			for (const inputPath of inputPaths) {
				if (!inputPath) continue;
				if (isExternalWritePath(inputPath)) {
					externalWrites.push({ path: inputPath, detail: `- ${inputPath} (outside the workspace)` });
				} else if (!isPathWithinCwd(inputPath, cwd)) {
					const resolved = resolveToolPath(inputPath, cwd);
					externalWrites.push({ path: inputPath, detail: `- ${inputPath} (resolved: ${resolved}, outside the workspace)` });
				}
			}
			if (externalWrites.length > 0) {
				const message = `Paths outside the workspace:\n${externalWrites.map((w) => w.detail).join("\n")}`;
				steps.push(guardianAsk(
					"External Write",
					message,
					["external-write"],
					"External Path",
					externalWrites[0].path,
					"Auto-review: external write blocked.",
				));
			}
		} else {
			// Default mode: per-path user prompts (unchanged)
			for (const inputPath of inputPaths) {
				if (inputPath && isExternalWritePath(inputPath)) {
					steps.push(userAsk(
						"External Path",
						`Default mode: path "${inputPath}" is outside workspace.\nAllow write?`,
						inputPath,
						"Write to external path blocked.",
					));
				}
				// Also catch non-external paths that are still outside cwd
				if (inputPath && !isPathWithinCwd(inputPath, cwd) && !isExternalWritePath(inputPath)) {
					const resolved = resolveToolPath(inputPath, cwd);
					steps.push(userAsk(
						"External Path",
						`Default mode: path "${inputPath}" (resolved: ${resolved}) is outside workspace.\nAllow write?`,
						inputPath,
						"Write to external path blocked.",
					));
				}
			}
		}
	}

	return steps;
}
```

Notes on the transformation:

- The execpolicy ask is a bespoke literal (not `userAsk`) because it is the one site whose denial title differs from the prompt title and whose declined reason is `fixed`.
- Multiple block steps may be pushed in the read-only section where the current code returns the first match. The lifecycle stops at the first block step, so the surfaced reason is identical; the extra steps are dead but make the verdict faithful to each independent check. One of them is dead in today's code outright: the read-only bash `Command blocked: …` block is unreachable because the write-tool block fires first for every non-`list` bash command (`bash` ∈ `WRITE_TOOLS`), and every `list` command is a read-only shell command (`isReadOnlyShellCommand` returns true for snapshot operations). It is kept as classifier data, pinned by a classifier test; the lifecycle can never surface it.
- `hasUI` is consulted only by the execpolicy branch, exactly as today. User/Guardian asks are emitted regardless of `hasUI`; the lifecycle's approval dispositions decide what a no-UI environment does with them (unchanged behavior).

### Lifecycle: the step walk (`permission-enforcement-lifecycle.ts`)

Only `evaluate()` changes; `requestApproval` (127–145) and `guardianReview` (147–187) stay byte-identical, as does the adapter interface. The import changes from `evaluateToolCall` to `classifyToolCall` (value import; the lifecycle still imports `ApprovalResult` as a type via policy-types, unchanged).

```ts
		async evaluate(call, environment) {
			const key = permissionActionKey(call.toolName, call.input);
			if (oneShotApprovals.delete(key)) return { kind: "allowed", source: "one-shot" };

			const evaluationMode = currentMode.mode;
			const evaluationGeneration = authorizationGeneration;
			let promptedDenial = false;
			let allowedSource: "policy" | "user" | "guardian" = "policy";
			const recordAllowedSource = (source: "user" | "guardian") => {
				allowedSource = source;
			};
			const recordDenied = (denial: { title: string; message: string }) => {
				if (!environment.hasUI || evaluationGeneration !== authorizationGeneration) return;
				promptedDenial = true;
				lastDeniedAction = {
					key,
					title: denial.title,
					message: denial.message,
					at: now(),
				};
			};

			const steps = classifyToolCall(call, {
				mode: evaluationMode,
				cwd: environment.cwd,
				hasUI: environment.hasUI,
				execPolicy: environment.execPolicy,
			});
			if (steps.length === 0) return { kind: "allowed", source: "policy" };

			for (const step of steps) {
				if (step.kind === "block") {
					if (!promptedDenial) lastDeniedAction = undefined;
					return { kind: "blocked", reason: step.reason, approvable: promptedDenial };
				}
				const result = step.channel === "guardian"
					? await guardianReview(environment, step.title, step.message, [...(step.triggers ?? [])], recordAllowedSource)
					: await requestApproval(environment, evaluationMode, step.title, step.message, recordAllowedSource);
				if (result.allowed) continue;
				const reason = step.declinedReason.kind === "fixed"
					? step.declinedReason.reason
					: result.reason ?? step.declinedReason.reason;
				recordDenied(step.denial);
				return { kind: "blocked", reason, approvable: promptedDenial };
			}
			return { kind: "allowed", source: allowedSource };
		},
```

Parity notes on the walk:

- `recordDenied` reuses the pre-computed `key`; the old `onDenied` recomputed it from the (identical) call — same value, and the `hasUI`/`authorizationGeneration` gate and `promptedDenial`/`lastDeniedAction` semantics are byte-equivalent (old lines 244–252).
- Block step: `if (!promptedDenial) lastDeniedAction = undefined;` preserves old lines 257's clearing rule; `approvable: promptedDenial` preserves "only a recorded prompted denial is retryable".
- `allowedSource`: `"policy"` when no ask resolved (old default), last resolved channel wins — `recordAllowedSource` fires inside the unchanged helpers exactly as before.
- Guardian triggers: `[...(step.triggers ?? [])]` satisfies `guardianReview`'s `string[]` parameter; guardian asks always carry triggers (pinned by classifier tests).

### Caller migration: `index.ts`

```diff
 import {
 	createPermissionEnforcementLifecycle,
-	permissionActionKey,
 } from "./permission-enforcement-lifecycle.ts";
 import {
 	buildGuardianConversationEvidence,
 	type GuardianSkillInvocation,
 } from "./guardian-evidence.ts";
-import { evaluateToolCall } from "./permission-policy.ts";
 
 // Re-exported for backward compatibility (guardian-config.test.ts and external
 // importers depend on these public functions).
 export { parseGuardianDefinition, resolveGuardianPath };
 export type { GuardianDefinition } from "./guardian-runner.ts";
 
-export { permissionActionKey as actionKey, evaluateToolCall };
```

`permissionActionKey` has no other use inside index.ts (verified) and no consumer of the `actionKey` alias exists anywhere in the repo. `permissionActionKey` stays exported from the lifecycle module for its tests.

### Behavior parity checklist

Everything below is pinned by either the unchanged lifecycle suite or the rewritten classifier tests.

| # | Behavior | Preserved by |
|---|---|---|
| 1 | Execpolicy block reason strings (`Execpolicy blocked: …`) | classifier literal + block-step test |
| 2 | Execpolicy no-UI fail-closed (`Execpolicy requires prompt: …`) | classifier literal (hasUI gate) + test |
| 3 | Execpolicy prompt titles (`Execpolicy Check` / `Execpolicy - Default Prompt`) | classifier + tests |
| 4 | Execpolicy fixed denial reason `"User declined via execpolicy prompt."` (result reason ignored) | `declinedReason {kind:"fixed"}` + lifecycle case |
| 5 | Execpolicy denial record `{title: "Execpolicy Check", message: command.slice(0, 200)}` | per-step denial + test |
| 6 | Read-only block reasons (write tool / network tool / out-of-cwd path / bash command) | classifier literals + tests |
| 7 | Snapshot `list` exception in read-only | classifier branch + test |
| 8 | Snapshot-helper wrapper block | classifier literal + test |
| 9 | Default per-trigger asks in order (dangerous → network → snapshot-removal) | step order + ordering test |
| 10 | Auto-review single Guardian review with merged triggers in canonical order | classifier + test |
| 11 | Auto-review concerns message text incl. 5-path truncation + `... and N more` | classifier verbatim + test |
| 12 | Auto-review external-write denial record `{title: "External Path", message: externalWrites[0].path}` | per-step denial + test |
| 13 | Network-tool ask (`Network Tool`) | classifier + test |
| 14 | Sensitive-path asks per path | classifier + test |
| 15 | Default external-write asks, both message variants | classifier + test |
| 16 | Prompt denial reason `"User declined."` (lifecycle) wins over site fallbacks | `result.reason ?? fallback` + new lifecycle case |
| 17 | Denial recording gated by `hasUI` + generation; `approvable = promptedDenial` | `recordDenied` byte-equivalent + unchanged tests |
| 18 | `lastDeniedAction` cleared on static block when no denial was recorded | block-step branch + unchanged test |
| 19 | `allowedSource` = last resolved channel, `"policy"` if none | `recordAllowedSource` in unchanged helpers + unchanged tests |
| 20 | One-shot approval bypass precedes classification | unchanged lines |
| 21 | Lifecycle appends `\n\nProceed?` to every prompt | unchanged `requestApproval` helper |
| 22 | Double `\n\nProceed?` on execpolicy prompts (pre-existing quirk) | carried verbatim — noted, not fixed |

### Parity table: interaction sites (prompt data → denial record → declined reason)

| Site (conditions) | Prompt title | Prompt message | Denial record `{title, message}` | declinedReason |
|---|---|---|---|---|
| Execpolicy matched prompt (bash, any mode, hasUI) | `Execpolicy Check` | `Rule matched: ${reason\|\|pattern}\n\nCommand: ${command.slice(0,200)}\n\nProceed?` | `{Execpolicy Check, command.slice(0,200)}` | fixed: `User declined via execpolicy prompt.` |
| Execpolicy default prompt (bash, unmatched, defaultAction prompt, hasUI) | `Execpolicy - Default Prompt` | `No allow rule matched; default action is prompt.\n\nCommand: ${command.slice(0,200)}\n\nProceed?` | `{Execpolicy Check, command.slice(0,200)}` | fixed: `User declined via execpolicy prompt.` |
| Sensitive path (default, path-read tool) | `Sensitive Path` | ``Tool `${toolName}` appears to read a sensitive path.\n\nPath: ${inputPath}`` | `{Sensitive Path, same as prompt}` | fallback: `Sensitive path access blocked.` |
| Dangerous command (default bash) | `Dangerous Command` | `Default mode detected: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0,200)}` | `{Dangerous Command, trimmedCmd.slice(0,200)}` | fallback: `Blocked.` |
| Network command (default bash) | `Network Access` | `Command appears to require network access.\n\nCommand: ${trimmedCmd.slice(0,200)}` | `{Network Access, trimmedCmd.slice(0,200)}` | fallback: `Network access blocked.` |
| Snapshot removal (default bash) | `Repository Snapshot Removal` | `This command deletes a stored repository source snapshot.\n\nCommand: ${trimmedCmd.slice(0,200)}` | `{Repository Snapshot Removal, trimmedCmd.slice(0,200)}` | fallback: `Repository snapshot removal blocked.` |
| Guardian command review (auto-review bash, triggers > 0) | `Command Review` | `Command: ${trimmedCmd}\n\nConcerns:\n${concerns.join("\n")}` | `{Command Review, same as prompt}` | fallback: `Auto-review: command blocked.` |
| Network tool (default) | `Network Tool` | ``Tool `${toolName}` requires network access.`` | `{Network Tool, same as prompt}` | fallback: `Network access blocked.` |
| Guardian external write (auto-review write/edit) | `External Write` | `Paths outside the workspace:\n${details.join("\n")}` | `{External Path, externalWrites[0].path}` | fallback: `Auto-review: external write blocked.` |
| External path — external (default write/edit) | `External Path` | `Default mode: path "${inputPath}" is outside workspace.\nAllow write?` | `{External Path, inputPath}` | fallback: `Write to external path blocked.` |
| External path — outside cwd (default write/edit) | `External Path` | `Default mode: path "${inputPath}" (resolved: ${resolved}) is outside workspace.\nAllow write?` | `{External Path, inputPath}` | fallback: `Write to external path blocked.` |

Guardian command-review triggers, in canonical order: `dangerous`, `network`, `repository-snapshot-removal`, `external-path`. Guardian external-write triggers: `["external-write"]`.

### Parity table: block sites

| Site (conditions) | Reason (verbatim) |
|---|---|
| Execpolicy rule/default block (bash, all modes) | `Execpolicy blocked: ${policy.rule?.reason \|\| "default block"}` |
| Execpolicy prompt + no UI (bash, all modes) | `Execpolicy requires prompt: ${policy.rule?.reason \|\| "default prompt"}` |
| Read-only write tool | ``Approval mode is read-only. Tool `${toolName}` is blocked. Use /permissions default to allow modifications.`` |
| Read-only network tool | `Approval mode is read-only. Network tool `${toolName}` is blocked.` |
| Read-only out-of-cwd path (per path) | `Read-only mode: path "${inputPath}" is outside current directory (${cwd}). Only paths within the workspace are accessible.` |
| Snapshot-helper wrapper (default/auto-review bash) | `Unrecognized GitHub snapshot helper command. Use the exact command shown by the github-repo-explorer skill.` |
| Read-only bash non-read-only command | `Approval mode is read-only. Command blocked: ${trimmedCmd.slice(0, 80)}. Use /permissions default to allow writes.` |

### Parity table: reachable verdict sequences

| Conditions | Verdict steps |
|---|---|
| bash + execpolicy rule block (any mode) | `[execpolicy-block, …dead mode steps below]` — the walk surfaces the execpolicy block |
| bash + execpolicy prompt rule + no UI | `[execpolicy-block("requires prompt"), …dead mode steps below]` — e.g. default mode appends the dead network ask |
| bash + execpolicy prompt rule + hasUI (any mode) | `[execpolicy-ask, …mode steps below]` |
| read-only + `write`/`edit` | `[read-only-write-block]` |
| read-only + network tool | `[read-only-network-block]` |
| read-only + path tool, path outside cwd | `[read-only-path-block]` (per path; extra block steps dead) |
| read-only + bash non-`list` command | `[execpolicy-ask?, read-only-write-block]` — **ask-then-block**; a trailing `read-only-command-block` is appended when the command is not read-only shell (dead data — see transformation notes) |
| default + path-read tool + sensitive path | `[sensitive-path-ask, …]` (per path) |
| default + bash | `[execpolicy-ask?, wrapper-block?, dangerous-ask, network-ask, snapshot-removal-ask]` |
| default + bash + execpolicy prompt rule + malformed helper wrap | `[execpolicy-ask, wrapper-block, network-ask]` — **ask-block-ask** (the malformed wrapper is always also a network command) |
| auto-review + bash | `[execpolicy-ask?, wrapper-block?, guardian-command-review]` |
| auto-review + bash + execpolicy prompt rule + malformed helper wrap | `[execpolicy-ask, wrapper-block, guardian-command-review]` — **ask-block-ask** |
| default + network tool | `[network-tool-ask]` |
| default + write/edit with external/outside-cwd paths | `[external-path-ask, …]` (per path) |
| auto-review + write/edit with external paths | `[guardian-external-write-ask]` |
| full-access (or any clean call) | `[]` → allowed, source `"policy"` (execpolicy still applies to bash) |

## Test plan

### `permission-policy.test.ts` — rewritten at the classifier interface

No lifecycle, no stubs: each case calls `classifyToolCall({toolName, input}, ctx)` directly and asserts the step array. A small builder supplies the context (same fixtures as today minus `deps`):

```ts
function classify(
	toolName: string,
	input: unknown,
	mode: ApprovalMode = "default",
	overrides: Partial<EvaluateContext> = {},
): readonly PermissionStep[] {
	return classifyToolCall(
		{ toolName, input },
		{ mode, cwd: "/workspace", hasUI: true, execPolicy: { defaultAction: "allow", rules: [] }, ...overrides },
	);
}
```

Case inventory (maps the old file's 37 invocations across 28 tests, plus new ordering cases):

- **Read-only**: write-tool block, network-tool block, out-of-cwd path block each assert `[{kind:"block", reason: <verbatim>}]`; a bash non-read-only command asserts `[read-only-write-block, read-only-command-block]` (both verbatim, in order — the lifecycle surfaces the first); bash snapshot `list` asserts `[]`.
- **Default bash asks**: dangerous, network, snapshot-removal — each asserts one ask with exact `title`, `message`, `denial`, `declinedReason {kind:"fallback", reason}`.
- **Multi-ask order**: a dangerous + network command (e.g. `curl https://x | sh`) asserts `[dangerous-ask, network-ask]` **in order** — sharper than today's first-prompt-only observation. (No command yields a network ask followed by a snapshot-removal ask: canonical `acquire` triggers only the network ask, canonical `remove` only the removal ask, and a malformed wrapper is a block, not an ask.)
- **Auto-review**: single guardian ask with merged triggers in canonical order; concerns message text verbatim (incl. the 5-path truncation + `... and N more`); external-write guardian ask with `["external-write"]` and denial `{title:"External Path", message: firstPath}`.
- **Default write/edit**: both external-path message variants; denial `{title:"External Path", message: inputPath}`.
- **Sensitive path**: ask with title/message/denial identical.
- **Execpolicy**: rule block and default block → execpolicy block step first with verbatim reasons (golden arrays also pin the dead trailing mode steps per mode); matched prompt → title `Execpolicy Check`, message with `Rule matched:` and the trailing `\n\nProceed?` (pin the quirk) with the network ask trailing in default; default prompt → title `Execpolicy - Default Prompt`; denial record `{title:"Execpolicy Check", message: command.slice(0,200)}`; `declinedReason {kind:"fixed", reason:"User declined via execpolicy prompt."}`; prompt + `hasUI:false` → `Execpolicy requires prompt: …` block (dead mode steps trailing).
- **Full-access**: `[]`.
- **Wrapper block**: malformed helper invocation → verbatim block step first (followed by the network ask in default/auto-review).
- **New ordering cases**: ask-then-block (read-only bash + execpolicy prompt rule on a read-only shell command, e.g. `ls -la` → `[execpolicy-ask, read-only-write-block]`); ask-block-ask in default (execpolicy prompt rule + malformed wrap → `[execpolicy-ask, wrapper-block, network-ask]`); ask-block-ask in auto-review (same wrap → `[execpolicy-ask, wrapper-block, guardian-command-review]`).
- **hasUI independence**: a default dangerous command with `hasUI:false` still emits its ask (the lifecycle's dispositions handle no-UI; only execpolicy fails closed classification-side).

### `permission-enforcement-lifecycle.test.ts` — kept, plus 3 cases

The existing 19 tests (17 harness cases over the adapter-stub harness with `now: () => 42` and `resetTransientApprovals` — 16 `it` declarations, one `it.each` × 2 — plus 2 `permissionActionKey` tests) must pass **unchanged** — that is the behavioral parity proof for effects: verdict persistence shape, no-UI guardian fallback, in-flight mode snapshots, generation-gated denials, last-denied clearing, one-shot approvals, permission-mode markers.

Added cases:

1. **Prompt-denial reason passthrough** — default mode, dangerous bash, `requestUserConfirmation` resolves `false` → blocked with reason `"User declined."` (the approval result's reason wins; the step fallback `"Blocked."` must not surface) and `approvable: true`.
2. **Multi-ask short-circuit** — default mode, bash command triggering dangerous + network prompts (e.g. `curl https://x | sh`); deny the first prompt → exactly one prompt recorded, blocked reason `"User declined."`, second ask never resolved.
3. **Ask-then-block** — two resolutions in one case. Fixed flavor: read-only mode + execpolicy prompt rule + `hasUI: true` → the approval disposition denies the execpolicy ask *without prompting* (`requestUserConfirmation` never called) and the step's fixed reason `"User declined via execpolicy prompt."` surfaces over the disposition's `"Read-only mode."`, with `approvable: true` and the denial record retryable (`approveLastDenied` yields `{title: "Execpolicy Check", message: "ls -la", at: 42}`). Allowance flavor: default mode + execpolicy prompt rule + malformed helper wrap; the prompt is allowed → the wrapper block terminates the walk with `approvable: false`, exactly one prompt (the trailing network ask never resolves).

### `index.test.ts`, `commands.test.ts`, others — untouched

No test imports `actionKey`/`evaluateToolCall` from index (verified: zero hits). Typecheck is the guard.

## Documentation updates

1. **CONTEXT.md — done at decision time.** The Safety section now has the new **Permission classification module** entry (pure verdict classification, precomputable, execpolicy no-UI fail-closed classification-side, resolved in order by the lifecycle) and the sharpened **Permission enforcement lifecycle** entry (verdict resolution + transient-approval state owned here; check ordering is data owned by the classifier).
2. **File headers** — `permission-policy.ts` and `policy-types.ts` headers are rewritten in the implementation above to describe the verdict protocol.
3. No other docs: the safety suite has no dedicated docs file, and no ADR is warranted (same depth direction as prior landed plans).

## Verification

```sh
pnpm -C .pi typecheck
pnpm -C .pi test:safety   # 15 files today; lifecycle suite must pass unchanged, +3 cases
pnpm -C .pi test:shared   # command-policy untouched; sanity
rg -n "EvaluateDeps|PermissionDecision" .pi/extensions/   # expect: no hits
rg -n "evaluateToolCall" .pi/extensions/                  # expect: no hits
rg -n "classifyToolCall" .pi/extensions/                  # expect: policy-types? no — classifier, lifecycle, both tests
git diff --stat                                           # scope: policy-types.ts, permission-policy.ts,
                                                          # permission-enforcement-lifecycle.ts, index.ts,
                                                          # permission-policy.test.ts, permission-enforcement-lifecycle.test.ts
```

Baseline test counts before this change: `test:safety` 15 files / 153 tests; `test:shared` 41 files / 492 tests. Expected deltas: +3 lifecycle tests (19 → 22); classifier test file rewritten in place (28 → 40 cases, all stub harnesses gone).

## Risks and mitigations

1. **Parity regression in a reason/title/denial record.** Mitigation: the four parity tables (behavior checklist, interaction sites, block sites, reachable sequences) are the review checklist; every row maps to a test; the lifecycle suite passing unchanged proves the effect layer.
2. **Sequence mis-encoding.** The verified reachable orderings — ask-then-block (read-only), and ask-block-ask in both default (trailing network ask) and auto-review (trailing Guardian ask) — get dedicated classifier tests; any encoding that flattens them fails loudly.
3. **`allowedSource` drift.** Last-wins semantics live inside the unchanged `requestApproval`/`guardianReview` helpers; existing lifecycle tests pin `"user"`, `"guardian"`, and `"policy"` sources, including the in-flight mode snapshot case.
4. **`approvable`/generation-gate drift.** `recordDenied` is byte-equivalent to the old `onDenied` gate; the generation-across-mode-change test pins it.
5. **Double `\n\nProceed?` quirk.** Carried verbatim and pinned by a classifier test; if it is ever to be fixed, that is a separate, deliberate behavior change — not smuggled into this migration.
6. **Fallback strings are production-dead but test-pinned.** Documented in decision 3; keeping them preserves each site's classifier-level parity data and the fixed/fallback union's symmetry. Deleting them would couple the verdict contract to a lifecycle-internal invariant ("resolvers always return a reason") — a worse trade for the nine site fallbacks (seven distinct strings).