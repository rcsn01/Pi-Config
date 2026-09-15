/**
 * Steer Input Extension
 *
 * Mid-turn steering and follow-up queuing without any editor replacement or
 * global keybinding changes.
 *
 * The mounted editor stays whatever the editor-slot module installed
 * (normally ui-message-history's PreviousMessageEditor). While the agent
 * streams, this extension registers one input handler with that module:
 *   Enter → steer (inject message after next tool call) — built-in pi behavior
 *   Tab   → queue the draft (delivered after the agent finishes)
 *
 * Tab queueing requires the mounted editor to extend the editor-slot
 * module's ModelCommandRoutingEditor, because the interception hook lives on
 * that base class; both session editors this repository contributes do. A
 * third-party editor that replaces the slot without that base class keeps
 * its own Tab behavior. Up-arrow history and normal Enter behavior stay
 * available at all times because no editor swap ever occurs — Pi's submit
 * path records Enter-submitted steers through the mounted history editor.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import {
	getModelCommandHandler,
	parseModelCommand,
	registerEditorInputHandler,
	type EditorInputHandler,
} from "../_shared/editor-slot.ts";

interface QueuedSlashCommand {
	text: string;
	submit?: (text: string) => void | Promise<void>;
	run?: () => Promise<void>;
}

export default function steerInputExtension(pi: ExtensionAPI) {
	let agentActive = false;
	let queuedCount = 0;
	let queuedSlashCommands: QueuedSlashCommand[] = [];
	let unregisterInputHandler: (() => void) | undefined;
	/** Session-start context; its ui getter resolves lazily, so it stays valid for streaming-time notifications. */
	let sessionCtx: ExtensionContext | undefined;

	function updateWidget(ctx: ExtensionContext): void {
		if (agentActive) {
			ctx.ui.setWidget("steer-hint", (_tui, theme) => ({
				render: (width: number) => [
					truncateToWidth(theme.fg("dim", "↩ Enter → steer · ⇥ Tab → queue for next turn"), Math.max(0, width), "…"),
				],
				invalidate: () => {},
			}));
		} else {
			ctx.ui.setWidget("steer-hint", undefined);
		}
	}

	/**
	 * Intercepts Tab while the agent streams. Queued drafts go through
	 * editor.addToHistory before the editor is cleared — Pi's own history
	 * insertion only covers Enter-submitted text, so this is what makes
	 * Tab-queued follow-ups and slash commands recallable with Up.
	 */
	const handleSteerInput: EditorInputHandler = (data, editor) => {
		if (!agentActive) return false;
		if (!matchesKey(data, Key.tab)) return false;
		const text = editor.getText().trim();
		if (!text) return true; // swallow empty/whitespace-only Tab without clearing
		if (text.startsWith("/")) {
			// pi.sendUserMessage(..., { deliverAs: "followUp" }) bypasses
			// slash-command parsing by design. Keep slash commands out of the
			// chat queue and submit them after the current response ends.
			const modelHandler = getModelCommandHandler();
			const modelArgs = modelHandler ? parseModelCommand(text) : undefined;
			if (modelHandler && modelArgs !== undefined) {
				queuedSlashCommands.push({ text, run: () => modelHandler(modelArgs) });
			} else {
				queuedSlashCommands.push({ text, submit: editor.onSubmit });
			}
			queuedCount++;
			sessionCtx?.ui.notify(
				`Queued slash command for after this response${queuedSlashCommands.length > 1 ? ` (${queuedSlashCommands.length} pending)` : ""}`,
				"info",
			);
		} else {
			pi.sendUserMessage(text, { deliverAs: "followUp" });
			queuedCount++;
			sessionCtx?.ui.notify(
				`Queued for next turn${queuedCount > 1 ? ` (${queuedCount} pending)` : ""}`,
				"info",
			);
		}
		// Record before clearing so the mounted history editor persists the
		// entry (this is the step Pi's submit path would otherwise perform).
		editor.addToHistory?.(text);
		editor.setText("");
		return true;
	};

	// ---- Agent lifecycle ----
	pi.on("agent_start", async (_event, ctx) => {
		agentActive = true;
		queuedCount = 0;
		updateWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentActive = false;
		updateWidget(ctx);

		// Copy and clear first so a callback that re-enters agent_end cannot
		// drain the same batch twice.
		const slashCommands = queuedSlashCommands;
		queuedSlashCommands = [];
		for (const { text, submit, run } of slashCommands) {
			if (run) {
				await run();
			} else if (submit) {
				await submit(text);
			} else {
				ctx.ui.setEditorText(text);
				ctx.ui.notify(`Queued slash command restored to editor: ${text}`, "info");
			}
		}
	});

	// ---- Steer notification (Enter during streaming) ----
	pi.on("input", async (event, ctx) => {
		if (!agentActive) return;
		if (event.streamingBehavior === "steer") {
			ctx.ui.notify("Steering agent...", "info");
		}
	});

	// ---- Reload / session start ----
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		sessionCtx = ctx;
		unregisterInputHandler?.();
		unregisterInputHandler = registerEditorInputHandler(handleSteerInput);
		if (agentActive) updateWidget(ctx);
	});

	// ---- Reload / shutdown cleanup ----
	pi.on("session_shutdown", async (_event, ctx) => {
		agentActive = false;
		queuedSlashCommands = [];
		unregisterInputHandler?.();
		unregisterInputHandler = undefined;
		sessionCtx = undefined;
		ctx.ui.setWidget("steer-hint", undefined);
	});
}
