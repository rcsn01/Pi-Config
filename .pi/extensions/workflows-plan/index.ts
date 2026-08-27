/**
 * Plan Mode Extension — `/plan` command
 *
 * Pi adapter for Plan Mode. Lifecycle policy and live state live in
 * `plan-lifecycle.ts`; this module keeps registration, command parsing, and
 * Session profile binding at the Pi seam.
 */

import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROFILES_DIRECTORY } from "../_shared/active-profile.ts";
import { registerSessionProfileInitialization } from "../_shared/session-profile-initialization.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
import { registerPlanRenderers } from "./plan-renderer.ts";
import { createPlanLifecycle } from "./plan-lifecycle.ts";
import { createPlanWorkspace } from "./plan-workspace.ts";
import type { PlanModeDependencies } from "./plan-lifecycle.ts";

export { PLAN_REVIEW_ACTIONS, reviewActionLabels } from "./plan-review.ts";
export type { PlanReviewAction } from "./plan-review.ts";
export type { PlanModeDependencies } from "./plan-lifecycle.ts";

export function createPlanModeExtension(dependencies: PlanModeDependencies = {}) {
	return (pi: ExtensionAPI) => registerPlanModeExtension(pi, dependencies);
}

function registerPlanModeExtension(pi: ExtensionAPI, dependencies: PlanModeDependencies): void {
	const lifecycle = createPlanLifecycle(pi, {
		...dependencies,
		createWorkspace: dependencies.createWorkspace ?? createPlanWorkspace,
	});
	const profileInitialization = registerSessionProfileInitialization(
		{ settingsPath: PROJECT_SETTINGS_PATH, profilesDirectory: PROFILES_DIRECTORY },
		{
			name: "workflows-plan",
			applyPath: (binding) => lifecycle.setProfilePath(binding.settingsPath),
			initialize: (_binding, _event, ctx) => lifecycle.dispatch({ type: "sessionStarted", ctx }),
			dispose: (_binding, ctx) => lifecycle.dispatch({ type: "sessionStopping", ctx }),
		},
	);
	const planBash = createBashTool(process.cwd(), {
		operations: {
			async exec(command, cwd, options) {
				return lifecycle.dispatch({ type: "isolatedCommand", command, cwd, options });
			},
		},
	});
	pi.registerTool({
		...planBash,
		name: "plan_bash",
		label: "Plan Bash (isolated)",
		description:
			"Plan Mode only. Execute any shell command in a disposable, network-restricted copy of the workspace. Host files are not modified.",
		promptSnippet: "Execute arbitrary checks in an isolated disposable workspace",
		promptGuidelines: [
			"Use plan_bash for tests, builds, and shell exploration while Plan Mode is active; its filesystem changes are discarded.",
		],
	});
	registerPlanRenderers(pi);

	pi.on("session_start", async (event, ctx) => {
		await profileInitialization.start(event, ctx);
	});
	pi.on("session_tree", async (_event, ctx) => lifecycle.dispatch({ type: "branchChanged", ctx }));
	pi.on("session_shutdown", async (event, ctx) => {
		try {
			await profileInitialization.stop(event, ctx);
		} finally {
			profileInitialization.unregister();
		}
	});
	pi.on("model_select", async (event, ctx) => lifecycle.dispatch({
		type: "modelChanged",
		model: event.model,
		source: event.source,
		ctx,
	}));
	pi.on("thinking_level_select", async (event, ctx) => lifecycle.dispatch({
		type: "thinkingLevelChanged",
		level: event.level,
		ctx,
	}));
	pi.on("input", async (event, ctx) => lifecycle.dispatch({ type: "reviewInput", event, ctx }));
	pi.on("turn_end", async (_event, ctx) => lifecycle.dispatch({ type: "turnEnded", ctx }));
	pi.on("before_agent_start", async (event) => lifecycle.dispatch({ type: "agentPromptConstruction", event }));
	pi.on("message_end", async (event) => lifecycle.dispatch({ type: "assistantMessageCompleted", event }));
	pi.on("agent_settled", async (_event, ctx) => lifecycle.dispatch({ type: "agentSettled", ctx }));
	pi.on("tool_call", async (event) => lifecycle.dispatch({ type: "toolCall", event }));

	pi.registerCommand("plan-implement-fresh", {
		description: "Implement the latest proposed plan in a fresh session",
		handler: async (_args, ctx) => lifecycle.dispatch({ type: "implementDeferredFresh", ctx }),
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle plan mode",
		handler: async (ctx) => lifecycle.dispatch({ type: "modeToggled", source: "shortcut", ctx }),
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or use /plan <task|implement|fresh|revise|show|refresh|exit>",
		getArgumentCompletions: (prefix: string) => {
			const items = ["fresh", "implement", "accept", "revise ", "show", "refresh", "status", "exit"];
			return items.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const [command, ...rest] = trimmed.split(/\s+/);
			const subcommand = command?.toLowerCase();
			const feedback = rest.join(" ").trim();

			if (subcommand === "implement" || subcommand === "accept") {
				return lifecycle.dispatch({ type: "implementCurrent", ctx });
			}
			if (subcommand === "fresh") {
				return lifecycle.dispatch({ type: "implementFresh", ctx });
			}
			if (subcommand === "revise") {
				return lifecycle.dispatch({ type: "reviseRequested", ctx, feedback });
			}
			if (subcommand === "show") {
				return lifecycle.dispatch({ type: "showRequested", ctx });
			}
			if (subcommand === "refresh") {
				return lifecycle.dispatch({ type: "refreshRequested", ctx });
			}
			if (subcommand === "status") {
				return lifecycle.dispatch({ type: "statusRequested", ctx });
			}
			if (subcommand === "exit") {
				return lifecycle.dispatch({ type: "modeExited", ctx });
			}
			if (trimmed) {
				return lifecycle.dispatch({ type: "taskStarted", ctx, task: trimmed });
			}
			return lifecycle.dispatch({ type: "modeToggled", source: "command", ctx });
		},
	});
}

export default createPlanModeExtension();
