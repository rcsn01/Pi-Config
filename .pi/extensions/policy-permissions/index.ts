/**
 * Unified Command Safety Extension
 *
 * Four approval modes (vocabulary owned by ./mode-registry.ts):
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
import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { declareStatus } from "../_shared/status-registry.ts";
import { registerSessionProfileBinding, wireSessionProfileBinding } from "../_shared/session-profile-binding.ts";
import { formatTokenCount, modelKey, pickModelConfiguration } from "../_shared/model-picker.ts";
import { resolveModelContext } from "../_shared/model-selection.ts";
import { resolveModelReference } from "../_shared/model-reference.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
import { renderTranscriptCard } from "../_shared/transcript-card.ts";
import { loadExecPolicy } from "../_shared/command-policy.ts";
import { isProjectTrustedContext } from "../_shared/pi-config.ts";
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
import { modeRequestMarker, modeStatusLabel } from "./mode-registry.ts";
import {
	createPermissionEnforcementLifecycle,
	permissionActionKey,
} from "./permission-enforcement-lifecycle.ts";
import {
	buildGuardianConversationEvidence,
	type GuardianSkillInvocation,
} from "./guardian-evidence.ts";
import { evaluateToolCall } from "./permission-policy.ts";

// Re-exported for backward compatibility (guardian-config.test.ts and external
// importers depend on these public functions).
export { parseGuardianDefinition, resolveGuardianPath };
export type { GuardianDefinition } from "./guardian-runner.ts";

export { permissionActionKey as actionKey, evaluateToolCall };

const APPROVAL_MODE_STATUS_ID = "approval-mode";
declareStatus({ id: APPROVAL_MODE_STATUS_ID, style: "muted", order: 20 });

const PERMISSION_MARKER_CUSTOM_TYPE = "permission-mode-marker";

function isPermissionMarker(message: { role: string; customType?: string }): boolean {
	return message.role === "custom" && message.customType === PERMISSION_MARKER_CUSTOM_TYPE;
}

function createPermissionMarkerMessage(marker: string) {
	return {
		role: "custom" as const,
		customType: PERMISSION_MARKER_CUSTOM_TYPE,
		content: marker,
		display: false,
		timestamp: Date.now(),
	};
}

function skillInvocationFromInput(pi: ExtensionAPI, text: string): GuardianSkillInvocation | undefined {
	const commandName = /^\/(\S+)/.exec(text.trim())?.[1];
	if (!commandName) return undefined;
	const command = pi.getCommands().find((candidate) =>
		candidate.name === commandName && candidate.source === "skill"
	);
	if (!command) return undefined;
	return { name: command.name, source: command.sourceInfo.scope };
}

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
	let pendingSkillInvocation: GuardianSkillInvocation | undefined;
	let currentSkillInvocation: GuardianSkillInvocation | undefined;

	const enforcement = createPermissionEnforcementLifecycle<ExtensionContext>({
		loadMode: (cwd, options) => loadModeFromFile(cwd, options) ?? undefined,
		saveMode: (cwd, mode, options) => saveModeToFile(cwd, mode, options),
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
		ctx.ui.setStatus(APPROVAL_MODE_STATUS_ID, modeStatusLabel(enforcement.mode.mode));
	}

	// ── Command adapter ────────────────────────────────────────────────

	const commandService: CommandService = {
		getMode: () => enforcement.mode,
		changeMode: (mode, ctx) => {
			enforcement.changeMode(mode, { projectTrusted: isProjectTrustedContext(ctx) });
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
				enforcement.synchronizeSession({
					cwd: ctx.cwd,
					resetTransientApprovals: true,
					projectTrusted: isProjectTrustedContext(ctx),
				});
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
		enforcement.synchronizeSession({
			cwd: ctx.cwd,
			resetTransientApprovals: false,
			projectTrusted: isProjectTrustedContext(ctx),
		});
		updateStatus(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	// Capture explicit Skill invocation before Pi expands it into the user prompt.
	// Availability alone is not authorization, so only the invoked Skill is kept.
	pi.on("input", async (event) => {
		pendingSkillInvocation = skillInvocationFromInput(pi, event.text);
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
		const branchMessages = ctx.sessionManager.buildContextEntries()
			.flatMap((entry) => sessionEntryToContextMessages(entry));
		const outcome = await enforcement.evaluate(
			{ toolName: event.toolName, input: event.input },
			{
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				execPolicy: loadExecPolicy({ cwd: ctx.cwd, projectTrusted: isProjectTrustedContext(ctx) }),
				guardianContext: {
					conversation: buildGuardianConversationEvidence(branchMessages),
					...(currentSkillInvocation ? { invokedSkill: currentSkillInvocation } : {}),
				},
				hostContext: ctx,
			},
		);
		if (outcome.kind === "blocked") return { block: true, reason: outcome.reason };
	});

	// ── Request-local permission marker ─────────────────────────────────

	pi.on("context", async (event) => {
		// Context-hook messages are used only for this provider request. Remove any
		// stale marker before adding the current one so mode changes never accumulate
		// marker messages in the session context.
		const messages = event.messages.filter((message) => !isPermissionMarker(message));
		const marker = modeRequestMarker(enforcement.mode.mode);
		if (!marker) {
			return messages.length === event.messages.length ? undefined : { messages };
		}
		return { messages: [...messages, createPermissionMarkerMessage(marker)] };
	});

	pi.on("before_agent_start", async () => {
		currentSkillInvocation = pendingSkillInvocation;
		pendingSkillInvocation = undefined;
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
			// Seeds the picker's current-model marker for a stored previous choice
			// that may be outside the session's current scope.
			const configuredModel = commandSettings
				? await resolveModelReference(ctx, { provider: commandSettings.provider, modelId: commandSettings.modelId }, {
					optional: true,
					scope: "ignore",
				})
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
