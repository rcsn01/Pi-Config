/**
 * Unified Command Safety Extension
 *
 * Four approval modes:
 *   /permissions read-only    — Read-only browsing in current directory
 *   /permissions default      — Workspace-write with user approval prompts
 *   /permissions auto-review  — Full auto; only prompts you for edits outside the workspace
 *   /permissions full-access  — No restrictions (dangerous; confirm to enable)
 *
 * Commands:
 *   /guardian   — select the profile-scoped Guardian model
 *   /execpolicy — regex allow/prompt/block rules
 *
 * This Pi adapter wires the permission enforcement lifecycle to command
 * routing, Guardian execution, Session entries, context capture, and status
 * rendering. Policy ordering and mutable authorization state stay behind the
 * lifecycle interface.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSessionProfileBinding, wireSessionProfileBinding } from "../_shared/session-profile-binding.ts";
import { formatTokenCount, modelKey, pickModelConfiguration } from "../_shared/model-picker.ts";
import { resolveModelContext } from "../_shared/model-selection.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
import { renderTranscriptCard } from "../_shared/transcript-card.ts";
import { loadExecPolicy } from "../_shared/command-policy.ts";
import { runGuardianReview } from "./approvals.ts";
import { registerPermissionCommands, type CommandService } from "./commands.ts";
import {
	disposeAutoReviewer,
	parseGuardianDefinition,
	resolveGuardianPath,
} from "./guardian-runner.ts";
import {
	loadGuardianSettings,
	saveGuardianSettings,
	type GuardianSettings,
} from "./guardian-settings.ts";
import { loadModeFromFile, saveModeToFile } from "./mode-store.ts";
import {
	createPermissionEnforcementLifecycle,
	permissionActionKey,
} from "./permission-enforcement-lifecycle.ts";
import { evaluateToolCall } from "./permission-policy.ts";

// Re-exported for backward compatibility (guardian-config.test.ts and external
// importers depend on these public functions).
export { parseGuardianDefinition, resolveGuardianPath };
export type { GuardianDefinition } from "./guardian-runner.ts";

export { permissionActionKey as actionKey, evaluateToolCall };

// ── Extension ──────────────────────────────────────────────────────────

export interface SafetyPermissionsDependencies {
	settingsPath?: string;
}

export function createSafetyPermissionsExtension(
	dependencies: SafetyPermissionsDependencies = {},
) {
	return (pi: ExtensionAPI) => installSafetyPermissions(pi, dependencies);
}

function installSafetyPermissions(
	pi: ExtensionAPI,
	dependencies: SafetyPermissionsDependencies,
): void {
	const settingsFilePath = dependencies.settingsPath ?? PROJECT_SETTINGS_PATH;
	let guardianSettingsPath = settingsFilePath;
	let guardianSettings: GuardianSettings | undefined;
	let profileBindingGeneration = 0;
	let lastUserPrompt = "";
	let lastAssistantMessage = ""; // most recent assistant message text (updated via message_end)
	let precedingAssistantMessage = ""; // snapshot of lastAssistantMessage at turn start — the prior turn's final assistant message (e.g. a proposal the user is replying to)

	const enforcement = createPermissionEnforcementLifecycle<ExtensionContext>({
		loadMode: (cwd) => loadModeFromFile(cwd) ?? undefined,
		saveMode: (cwd, mode) => saveModeToFile(cwd, mode),
		requestUserConfirmation: (ctx, title, message) => ctx.ui.confirm(title, message),
		runGuardianReview: (ctx, title, evaluationMessage) =>
			runGuardianReview(ctx, guardianSettings, title, evaluationMessage),
		persistGuardianVerdict: (_ctx, verdict) => {
			pi.appendEntry("auto-review-verdict", {
				title: verdict.title,
				allowed: verdict.allowed,
				reason: verdict.reason,
				...(verdict.model ? { model: verdict.model } : {}),
				...(verdict.usage ? { usage: verdict.usage } : {}),
				...(verdict.triggers.length > 0 ? { triggers: verdict.triggers } : {}),
			});
		},
	});

	// ── Status display ─────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		const modeLabels: Record<string, string> = {
			"read-only": "read-only",
			default: "default",
			"auto-review": "auto-review",
			"full-access": "full-access",
		};
		ctx.ui.setStatus("approval-mode", modeLabels[enforcement.mode.mode]);
	}

	// ── Command adapter ────────────────────────────────────────────────

	const commandService: CommandService = {
		getMode: () => enforcement.mode,
		changeMode: (mode) => {
			enforcement.changeMode(mode);
		},
		updateStatus,
		approveLastDenied: () => enforcement.approveLastDenied(),
	};

	const profileInitialization = registerSessionProfileBinding(
		{ settingsPath: settingsFilePath },
		{
			name: "policy-permissions",
			applyPath: (binding) => {
				guardianSettingsPath = binding.settingsPath;
			},
			initialize: async (_binding, _event, ctx) => {
				enforcement.synchronizeSession({ cwd: ctx.cwd, resetTransientApprovals: true });
				profileBindingGeneration++;
				try {
					guardianSettings = loadGuardianSettings(guardianSettingsPath);
				} catch (error) {
					guardianSettings = undefined;
					ctx.ui.notify(
						`Guardian settings are invalid; using guardian.md defaults: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				updateStatus(ctx);
			},
			dispose: async () => {
				profileBindingGeneration++;
				await disposeAutoReviewer();
			},
		},
	);

	// ── Events ──────────────────────────────────────────────────────────

	wireSessionProfileBinding(pi, profileInitialization);
	pi.on("session_tree", async (_event, ctx) => {
		enforcement.synchronizeSession({ cwd: ctx.cwd, resetTransientApprovals: false });
		updateStatus(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	// Track the most recent assistant message text so the guardian can see the agent's
	// preceding turn (e.g. a proposal/options the user is replying to).
	pi.on("message_end", async (event) => {
		if (event.message?.role !== "assistant") return;
		const text = extractAssistantText(event.message);
		if (text) lastAssistantMessage = text.slice(-2000);
	});

	// ── Custom rendering for auto-review verdict entries ──────────────

	pi.registerEntryRenderer("auto-review-verdict", (entry, options, theme) => {
		const data = entry.data as { allowed?: boolean; title?: string; reason?: string; triggers?: string[] } | undefined;
		const allowed = data?.allowed === true;
		const title = data?.title ?? "Command Review";
		const triggers = data?.triggers?.length ? `Triggers: ${data.triggers.join(", ")}` : undefined;
		return renderTranscriptCard(theme, {
			title,
			state: allowed ? "success" : "error",
			body: data?.reason ?? "No review reason provided.",
			summary: `${allowed ? "Allowed" : "Denied"} · ${title} · expand to view`,
			metadata: triggers ? [triggers] : undefined,
			expanded: Boolean(options?.expanded),
		});
	});

	// ── tool_call handler ──────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const outcome = await enforcement.evaluate(
			{ toolName: event.toolName, input: event.input },
			{
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				execPolicy: loadExecPolicy(),
				guardianContext: { lastUserPrompt, precedingAssistantMessage },
				hostContext: ctx,
			},
		);
		if (outcome.kind === "blocked") return { block: true, reason: outcome.reason };
	});

	// ── System prompt injection ────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		// Snapshot the prior turn's final assistant message before this turn begins.
		// This is the agent's preceding turn (e.g. a proposal/options the user is now
		// replying to) and gives the guardian authorization context. Snapshotted here so
		// current-turn assistant text cannot overwrite it before a tool_call fires.
		precedingAssistantMessage = lastAssistantMessage;
		lastUserPrompt = (event.prompt || "").slice(0, 500);
		const modeInstructions: Record<string, string> = {
			"read-only": `\n\n## Permission Mode: READ-ONLY\nYou are in read-only browsing mode, limited to the current directory.\n- You CAN read files, search code, list directories, and run read-only commands within ${event.systemPrompt.includes("cwd") ? "the workspace" : "the current directory"}.\n- You CANNOT modify files, run write commands, execute shell commands that change the system, or access the network.\n- Do NOT attempt to use write, edit, or bash for destructive operations.\n- Inform the user if a task requires write access. They can switch mode with /permissions default.`,
			default: `\n\n## Permission Mode: DEFAULT\nYou may read, write, and edit files within the current workspace, and run commands.\nApproval is required to:\n- Access the internet (curl, fetch, package installs, git push/pull/clone, etc.)\n- Write or edit files outside the workspace\n- Run dangerous commands (sudo, rm -rf, curl piped to shell)\nPrefer safe alternatives when possible.`,
			"auto-review": `\n\n## Permission Mode: AUTO-REVIEW\nFull auto — no restrictions on reading, writing within the workspace, web searches, or running commands.\nA guardian LLM reviews dangerous commands, network installs, and writes outside the workspace.\nSafe actions pass silently. Risky actions may trigger a user prompt.`,
			"full-access": `\n\n## Permission Mode: FULL ACCESS\nNo restrictions. You have full access to read, write, and execute any command, including network access and writing outside the workspace.\nExercise caution and always inform the user of destructive operations.`,
		};
		return { systemPrompt: event.systemPrompt + modeInstructions[enforcement.mode.mode] };
	});

	// ── Commands ────────────────────────────────────────────────────────

	registerPermissionCommands(pi, commandService);

	pi.registerCommand("guardian", {
		description: "Select the Guardian review model",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The /guardian model picker requires TUI mode.", "error");
				return;
			}

			const commandSettingsPath = guardianSettingsPath;
			const commandSettings = guardianSettings;
			const commandGeneration = profileBindingGeneration;
			const configuredModel = commandSettings
				? ctx.modelRegistry.find(commandSettings.provider, commandSettings.modelId)
				: undefined;
			try {
				const selection = await pickModelConfiguration(ctx, {
					initialQuery: args.trim(),
					previous: commandSettings,
					currentModel: configuredModel ? resolveModelContext(configuredModel) : undefined,
					modelTitle: "Select Guardian model",
					thinkingTitle: (model) => `Guardian thinking · ${modelKey(model)}`,
					contextTitle: (model) => `Guardian context · ${modelKey(model)}`,
				});
				if (!selection) return;
				if (profileBindingGeneration !== commandGeneration || guardianSettingsPath !== commandSettingsPath) {
					ctx.ui.notify("The session profile changed while the Guardian picker was open. Reopen /guardian.", "warning");
					return;
				}

				guardianSettings = await saveGuardianSettings(commandSettingsPath, selection);
				// Recreate lazily on the next review even when the selected key stayed
				// the same, so changed dynamic-provider transport settings take effect.
				await disposeAutoReviewer();
				ctx.ui.notify(
					`Guardian set to ${guardianSettings.provider}/${guardianSettings.modelId} · thinking ${guardianSettings.thinkingLevel} · context ${formatTokenCount(guardianSettings.contextWindow)}.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Could not configure Guardian: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

export default createSafetyPermissionsExtension();

// Extract readable text from an assistant message (content may be a string or an array of content blocks).
function extractAssistantText(message: any): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block: any) => block && block.type === "text" && typeof block.text === "string")
			.map((block: any) => block.text)
			.join("\n");
	}
	return "";
}
