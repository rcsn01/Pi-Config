import { join } from "node:path";
import {
	isContextOverflow,
	isRecoverableLength,
	type AssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ContextUsage,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { COMPACT_THRESHOLD } from "../_shared/auto-compact.ts";
import { isRecord, readSettingsDocument, writeSettingsDocument } from "../_shared/settings-document.ts";

/**
 * Claude/Codex-style auto-compaction.
 *
 * Disables Pi's native auto-compact (post-run threshold check) and replaces it
 * with compaction checked at the loop boundary (between tool/model cycles) at a
 * pre-emptive threshold below the context window, so the current turn continues
 * after compaction instead of ending.
 */

const CONTINUE_MESSAGE = "Continue the task using the compacted context.";
const CONTINUE_CUSTOM_TYPE = "auto-compact-continue";

export const SEMANTIC_COMPACTION_FOCUS = `
Create a loss-aware handoff for continuing the task.

Prioritize:
- The latest user objective, requirements, corrections, and acceptance criteria.
- Confirmed repository state, distinguished from planned or assumed work.
- Files, symbols, commands, test results, and exact important errors.
- Key decisions and their rationale.
- Failed approaches and why they failed.
- Current blockers, unresolved questions, and the exact next action.

Rules:
- Later user corrections supersede earlier instructions.
- Do not claim work is complete without supporting tool or test evidence.
- Preserve uncertainty instead of guessing.
- Remove verbose reasoning and obsolete conversational detail.
`;

export type OverflowCompactionAction = "compact-and-resume" | "compact";

/**
 * Classify provider responses that need extension-owned overflow recovery.
 * Responses from a previously selected model are ignored so stale errors cannot
 * compact a session after the user switches models.
 */
export function classifyOverflowCompaction(
	message: { role: string },
	model: Model<any> | undefined,
): OverflowCompactionAction | undefined {
	if (message.role !== "assistant" || !model) return undefined;

	const assistantMessage = message as AssistantMessage;
	if (
		assistantMessage.provider !== model.provider ||
		assistantMessage.model !== model.id
	) {
		return undefined;
	}

	if (isContextOverflow(assistantMessage, model.contextWindow)) {
		return assistantMessage.stopReason === "stop" ? "compact" : "compact-and-resume";
	}
	if (isRecoverableLength(assistantMessage, model.maxTokens)) {
		return "compact-and-resume";
	}
	return undefined;
}

/**
 * Whether compaction should run now, given the current context usage.
 * Returns false when usage is unknown (undefined, null tokens, or a
 * non-positive context window) or when usage is below the threshold.
 */
export function shouldCompactNow(
	usage: ContextUsage | undefined,
	threshold = COMPACT_THRESHOLD,
): boolean {
	if (!usage) return false;
	if (usage.tokens === null) return false;
	if (usage.contextWindow <= 0) return false;
	return usage.tokens >= usage.contextWindow * threshold;
}

/**
 * Veto Pi's native auto-compaction while letting manual `/compact` and our own
 * extension-triggered compaction pass. Both native paths are blocked because
 * this extension owns pre-emptive and overflow compaction; extension compaction
 * and `/compact` both appear as "manual".
 */
export function vetoNativeCompaction(
	reason: "manual" | "threshold" | "overflow",
): { cancel: true } | undefined {
	return reason === "manual" ? undefined : { cancel: true };
}

/**
 * Best-effort persistence: disable native auto-compaction in the settings file
 * at `settingsPath`, preserving all other keys. Returns true when a write
 * happened, false when already disabled or when the file could not be read or
 * parsed (fail silently).
 */
export function disableNativeCompaction(settingsPath: string): boolean {
	try {
		const settings = readSettingsDocument(settingsPath, { missing: "throw" });
		const compaction = isRecord(settings.compaction) ? settings.compaction : {};
		if (compaction.enabled === false) return false;
		settings.compaction = { ...compaction, enabled: false };
		writeSettingsDocument(settingsPath, settings);
		return true;
	} catch {
		return false;
	}
}

/**
 * Disable native auto-compaction in every settings file that still has it
 * enabled. Returns the paths that were actually written (already-disabled and
 * unreadable files are skipped silently).
 */
export function disableNativeCompactionInFiles(settingsPaths: readonly string[]): string[] {
	const written: string[] = [];
	for (const settingsPath of settingsPaths) {
		if (disableNativeCompaction(settingsPath)) written.push(settingsPath);
	}
	return written;
}

export default function autoCompactExtension(pi: ExtensionAPI): void {
	let compactionInProgress = false;
	let overflowRecoveryAttempted = false;

	const sendContinuation = (ctx: { isIdle(): boolean }): void => {
		if (!ctx.isIdle()) return;
		pi.sendMessage(
			{
				customType: CONTINUE_CUSTOM_TYPE,
				content: CONTINUE_MESSAGE,
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	// Runtime enforcement of the native auto-compact veto. Works immediately,
	// before the settings-file change is applied by a reload.
	pi.on("session_before_compact", (event) => vetoNativeCompaction(event.reason));

	// A real user message starts a new recovery budget. The hidden continuation
	// is a custom message, so it does not accidentally reset this guard.
	pi.on("message_start", (event) => {
		if (event.message.role === "user") overflowRecoveryAttempted = false;
	});

	// Persist the disabled native auto-compact setting on every session start,
	// in the project settings only. Project settings override global settings,
	// so the project-scoped flag is all that governs this project; writing
	// globally as well used to pair with a global extension entry, but that
	// only ever leaked the flag into unrelated projects where auto-compact
	// does not run (native compaction silently disabled with no replacement).
	// Idempotent: no write or notify when already disabled.
	pi.on("session_start", (_event, ctx) => {
		const written = disableNativeCompactionInFiles([
			join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"),
		]);
		if (written.length > 0) {
			ctx.ui.notify("Native auto-compact disabled. Run /reload to apply.", "info");
		}
	});

	// Mid-task compaction at the loop boundary: recover provider overflow first,
	// even when no tools ran. Otherwise, when context is at or above the
	// pre-emptive threshold after tool results, compact and resume the same turn.
	pi.on("turn_end", (event, ctx) => {
		const overflowAction = classifyOverflowCompaction(event.message, ctx.model);
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "stop" || event.message.stopReason === "toolUse")
		) {
			overflowRecoveryAttempted = false;
		}

		if (compactionInProgress) return;
		if (overflowAction) {
			const shouldResume = overflowAction === "compact-and-resume";
			if (shouldResume && overflowRecoveryAttempted) return;
			if (shouldResume) overflowRecoveryAttempted = true;

			compactionInProgress = true;
			ctx.compact({
				customInstructions: SEMANTIC_COMPACTION_FOCUS,
				onComplete: () => {
					compactionInProgress = false;
					if (shouldResume) sendContinuation(ctx);
				},
				onError: () => {
					compactionInProgress = false;
				},
			});
			return;
		}

		if (event.toolResults.length === 0) return; // run is ending; between-turns path handles it
		if (!shouldCompactNow(ctx.getContextUsage())) return;

		compactionInProgress = true;
		ctx.compact({
			customInstructions: SEMANTIC_COMPACTION_FOCUS,
			onComplete: () => {
				compactionInProgress = false;
				sendContinuation(ctx);
			},
			onError: () => {
				compactionInProgress = false;
			},
		});
	});

	// Between user turns: compact before the upcoming run starts so it runs
	// from the compacted context. `before_agent_start` is awaited by the session
	// before the agent loop, and the agent is idle here, so awaiting compaction
	// cannot deadlock.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (compactionInProgress) return;
		if (!shouldCompactNow(ctx.getContextUsage())) return;

		compactionInProgress = true;
		await new Promise<void>((resolve) => {
			ctx.compact({
				customInstructions: SEMANTIC_COMPACTION_FOCUS,
				onComplete: () => resolve(),
				onError: () => resolve(),
			});
		});
		compactionInProgress = false;
	});

	// Cleanup: never carry in-memory compaction state across sessions.
	pi.on("session_shutdown", () => {
		compactionInProgress = false;
		overflowRecoveryAttempted = false;
	});
}
