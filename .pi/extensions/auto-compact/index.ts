import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ContextUsage,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/**
 * Claude/Codex-style auto-compaction.
 *
 * Disables Pi's native auto-compact (post-run threshold check) and replaces it
 * with compaction checked at the loop boundary (between tool/model cycles) at a
 * pre-emptive threshold below the context window, so the current turn continues
 * after compaction instead of ending.
 */

const COMPACT_THRESHOLD = 0.8; // compact when context >= 80% of the model window
const CONTINUE_MESSAGE = "Continue the task using the compacted context.";
const CONTINUE_CUSTOM_TYPE = "auto-compact-continue";

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
 * extension-triggered compaction pass. Native paths are "threshold" (post-run
 * check) and "overflow" (context overflow recovery); our own compaction and
 * `/compact` both appear as "manual".
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
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			compaction?: { enabled?: boolean };
		};
		if (settings.compaction?.enabled === false) return false;
		settings.compaction = { ...(settings.compaction ?? {}), enabled: false };
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
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

	// Runtime enforcement of the native auto-compact veto. Works immediately,
	// before the settings-file change is applied by a reload.
	pi.on("session_before_compact", (event) => vetoNativeCompaction(event.reason));

	// Persist the disabled native auto-compact setting on every session start,
	// in both the global agent settings and the project settings (project
	// settings override global settings, so both must be covered). Idempotent:
	// no write or notify when already disabled.
	pi.on("session_start", (_event, ctx) => {
		const written = disableNativeCompactionInFiles([
			join(getAgentDir(), "settings.json"),
			join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"),
		]);
		if (written.length > 0) {
			ctx.ui.notify("Native auto-compact disabled. Run /reload to apply.", "info");
		}
	});

	// Mid-task compaction at the loop boundary: fires after each model response
	// plus tool results, before the next model call. When the context is at or
	// above the pre-emptive threshold, abort the run, compact, and resume the
	// same turn with the compacted context via a hidden continue message.
	pi.on("turn_end", (event, ctx) => {
		if (compactionInProgress) return;
		if (event.toolResults.length === 0) return; // run is ending; between-turns path handles it
		if (!shouldCompactNow(ctx.getContextUsage())) return;

		compactionInProgress = true;
		ctx.compact({
			onComplete: () => {
				compactionInProgress = false;
				if (ctx.isIdle()) {
					pi.sendMessage(
						{
							customType: CONTINUE_CUSTOM_TYPE,
							content: CONTINUE_MESSAGE,
							display: false,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}
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
				onComplete: () => resolve(),
				onError: () => resolve(),
			});
		});
		compactionInProgress = false;
	});

	// Cleanup: never leave the in-progress flag set across sessions.
	pi.on("session_shutdown", () => {
		compactionInProgress = false;
	});
}
