import { isPlanMode, type PlanPhase, type AgentModeState } from "./plan-state.ts";

export const MODE_POLICY_PROMPT = `

<plan_mode_policy>
The runtime mode marker reflects the mode at the start of this turn.
A runtime mode of plan means follow Plan Mode behavior.
A runtime mode of default means Plan Mode is inactive.
When asked about the current mode, answer from the final runtime marker.
If the marker conflicts with observable reality — for example, tools that Plan Mode disables (bash, edit, write) are available and working, or the user states the mode — the marker is stale: trust the live evidence and the user.
</plan_mode_policy>`;

export const DEFAULT_MODE_PROMPT = `

<default_mode>
Plan Mode is inactive for this turn. Normal execution is allowed.
Do not refuse work on the grounds that Plan Mode is active.
</default_mode>`;

export const PLAN_MODE_PROMPT = `

<collaboration_mode>
# Plan Mode (Conversational)

You are in **Plan Mode** until system/developer instructions say otherwise. User intent, tone, or imperative language does not end Plan Mode. If the user asks for execution while still in Plan Mode, treat that as a request to **plan the execution**, not perform it.

## Plan Mode vs todo/update_plan

Plan Mode is a collaboration mode for producing a decision-complete implementation plan. It is separate from TODO/checklist/progress tools. Do not use todo/update_plan-style tools while in Plan Mode.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

Allowed non-mutating actions include:
- Reading or searching files, configs, schemas, types, manifests, docs, and logs
- Static analysis, repository exploration, and dry-run style commands
- Tests, builds, or checks when their purpose is to validate feasibility
- Arbitrary shell commands through \`plan_bash\`, which runs in a disposable isolated copy of the workspace

\`plan_bash\` cannot modify the host workspace or external filesystem state. Its generated files are discarded when Plan Mode exits. Native \`read\`, \`grep\`, \`find\`, and \`ls\` tools continue to inspect the live host workspace. If the host changes while planning, use \`/plan refresh\` to rebuild the disposable copy. External network access is unavailable; use dedicated research tools instead.

Not allowed:
- Editing or writing files
- Running formatters, migrations, codegen, or linters that rewrite files
- Applying patches
- Creating/removing worktrees, syncing external project managers, or otherwise changing repo/external state
- Side-effectful commands whose purpose is doing the work rather than planning it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## Phase 1 — Ground in the environment

Start by discovering facts. Before asking the user a question, do at least one targeted non-mutating exploration pass unless no local environment/repo is available. Do not ask questions that can be answered from the repo or system.

## Phase 2 — Clarify intent

Ask only questions that materially affect the plan, confirm important assumptions, or choose between meaningful tradeoffs. Prefer concrete options and recommend a default.

If important ambiguity remains after exploration, use the \`ask_user\` tool to ask 1–3 concise multiple-choice questions. Each question must have meaningful options, and you should mark a recommended option when appropriate. Incorporate the selected answers before finalizing the plan. Do not ask clarification questions that can be answered by non-mutating exploration.

## Phase 3 — Finalize the implementation plan

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When presenting the official plan, wrap it exactly in one block:

<proposed_plan>
# Title

## Summary
...

## Implementation Changes
...

## Test Plan
...

## Assumptions
...
</proposed_plan>

Rules for the proposed plan:
- Opening and closing tags must be on their own lines.
- Use Markdown inside the block.
- Produce exactly one <proposed_plan> block when finalizing a plan, and no other plan text outside the block.
- If revising a previous plan and the feedback materially changes the plan, output a complete replacement plan.
- If revising feedback is a no-op, ambiguous, or repeats the existing plan, do not emit another <proposed_plan>; briefly say that the current plan already covers it and ask for specific changes.
- If the user says "continue", "ok", "go ahead", "implement", or repeats the same plan after a proposed plan exists, do not restate the plan. Treat it as plan review/acceptance ambiguity and respond briefly unless the Plan Mode extension intercepts it.
- Do not ask "should I proceed?" in the final plan; the user can leave Plan Mode and request implementation.
</collaboration_mode>`;

const REVIEW_STATE_PROMPT = `

<plan_review_state>
A proposed plan already exists. Prefer targeted revision or concise no-op acknowledgement over restating the whole plan. Only emit a new <proposed_plan> block when the user's latest feedback materially changes the plan.
</plan_review_state>`;

export function runtimeModeMarker(state: AgentModeState): string {
	return `\n\n<runtime mode="${state.mode}" revision="${state.revision}"/>`;
}

export function stripGeneratedModeContext(systemPrompt: string): string {
	return systemPrompt
		.replaceAll(MODE_POLICY_PROMPT, "")
		.replaceAll(DEFAULT_MODE_PROMPT, "")
		.replaceAll(PLAN_MODE_PROMPT, "")
		.replace(/\n*<plan_mode_policy>[\s\S]*?<\/plan_mode_policy>/g, "")
		.replace(/\n*<mode_policy>\s*The final runtime mode marker is authoritative[\s\S]*?<\/mode_policy>/g, "")
		.replace(/\n*<default_mode>[\s\S]*?<\/default_mode>/g, "")
		.replace(/\n*<collaboration_mode>\s*# Plan Mode \(Conversational\)[\s\S]*?<\/collaboration_mode>/g, "")
		.replace(/\n*<plan_review_state>[\s\S]*?<\/plan_review_state>/g, "")
		.replace(/\n*<plan_mode_state>[\s\S]*?<\/plan_mode_state>/g, "")
		.replace(/\n*<mode_change_note>[\s\S]*?<\/mode_change_note>/g, "")
		.replace(/\n*<runtime mode="(?:default|plan)" revision="\d+"\/>/g, "");
}

export interface PlanPromptSnapshot extends AgentModeState {
	phase?: PlanPhase;
}

export type ModeChange = "entered" | "exited";

/**
 * Prominent note announcing a mode flip since the previous turn, so the model
 * cannot anchor on a stale mode. Placed right after the policy block, before
 * the long mode prompt.
 */
export function modeChangeNote(modeChange: ModeChange | undefined): string {
	if (modeChange === undefined) return "";
	return `\n\n<mode_change_note>Plan Mode was ${modeChange} since the previous turn.</mode_change_note>`;
}

/** Build the complete generated context with exactly one final runtime marker. */
export function buildPlanModeSystemPrompt(
	systemPrompt: string,
	snapshot: PlanPromptSnapshot,
	modeChange?: ModeChange,
): string {
	const stablePrompt = stripGeneratedModeContext(systemPrompt) + MODE_POLICY_PROMPT;
	const note = modeChangeNote(modeChange);
	if (!isPlanMode(snapshot)) return stablePrompt + note + DEFAULT_MODE_PROMPT + runtimeModeMarker(snapshot);
	const reviewPrompt = snapshot.phase === "awaiting_review" ? REVIEW_STATE_PROMPT : "";
	return stablePrompt + note + PLAN_MODE_PROMPT + reviewPrompt + runtimeModeMarker(snapshot);
}
