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
 * Tab defers to the editor whenever Tab means "complete": while an
 * autocomplete popup is open, or while the cursor sits on an uncompleted
 * slash token ("/mo" with no space yet), the key falls through and the
 * built-in editor completes the command. A second Tab, once the command is
 * completed (trailing space) or for plain text, queues the draft.
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
import { matchesKey, Key, truncateToWidth, type EditorComponent } from "@earendil-works/pi-tui";
import {
	createSessionEditorLifetime,
	getModelCommandHandler,
	parseModelCommand,
	type EditorInputHandler,
} from "../_shared/editor-slot.ts";

interface QueuedSlashCommand {
	text: string;
	submit?: (text: string) => void | Promise<void>;
	run?: () => Promise<void>;
}

/**
 * True when the built-in editor would turn this Tab into a completion: an
 * autocomplete popup is open, or the cursor sits on a first-line slash token
 * with no space yet (pi-tui's handleTabCompletion slash branch). Those keys
 * must fall through so Tab completes instead of queueing. isShowingAutocomplete,
 * getCursor, and getLines are public on pi-tui's Editor but absent from the
 * EditorComponent interface, so detect them structurally and keep queueing
 * behavior for editors that lack them.
 */
function tabWouldComplete(editor: EditorComponent): boolean {
	const completionAware = editor as EditorComponent & {
		isShowingAutocomplete?: () => boolean;
		getCursor?: () => { line: number; col: number };
		getLines?: () => string[];
	};
	if (typeof completionAware.isShowingAutocomplete === "function" && completionAware.isShowingAutocomplete()) {
		return true;
	}
	if (typeof completionAware.getCursor !== "function" || typeof completionAware.getLines !== "function") {
		return false;
	}
	const { line, col } = completionAware.getCursor();
	if (line !== 0) return false;
	const beforeCursor = (completionAware.getLines()[line] ?? "").slice(0, col);
	return beforeCursor.trimStart().startsWith("/") && !beforeCursor.trimStart().includes(" ");
}

export default function steerInputExtension(pi: ExtensionAPI) {
	let agentActive = false;
	let queuedCount = 0;
	let queuedSlashCommands: QueuedSlashCommand[] = [];
	const editorLifetime = createSessionEditorLifetime(pi);
	/** Session-start context; its ui getter resolves lazily, so it stays valid for streaming-time notifications. */
	let sessionCtx: ExtensionContext | undefined;

	function updateWidget(ctx: ExtensionContext): void {
		if (agentActive) {
			ctx.ui.setWidget("steer-hint", (_tui, theme) => ({
				render: (width: number) => [
					truncateToWidth(theme.fg("dim", "↩ Enter → steer · ⇥ Tab → complete or queue next turn"), Math.max(0, width), "…"),
				],
				invalidate: () => {},
			}));
		} else {
			ctx.ui.setWidget("steer-hint", undefined);
		}
	}

	/**
	 * Intercepts Tab while the agent streams, except when Tab would trigger
	 * editor completion (open autocomplete popup or an uncompleted slash
	 * token); those keys fall through so slash menus keep working mid-turn.
	 * Queued drafts go through editor.addToHistory before the editor is
	 * cleared — Pi's own history insertion only covers Enter-submitted text,
	 * so this is what makes Tab-queued follow-ups and slash commands
	 * recallable with Up.
	 */
	const handleSteerInput: EditorInputHandler = (data, editor) => {
		if (!agentActive) return false;
		if (!matchesKey(data, Key.tab)) return false;
		// Completion wins over queueing; a second Tab queues the completed command.
		if (tabWouldComplete(editor)) return false;
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
	pi.on("session_start", async (event, ctx) => {
		editorLifetime.dispose();
		if (ctx.mode !== "tui") return;
		sessionCtx = ctx;
		editorLifetime.install(event, ctx, {
			id: "ui-steer-input",
			editorInputHandler: handleSteerInput,
		});
		if (agentActive) updateWidget(ctx);
	});

	// ---- Reload / shutdown cleanup ----
	pi.on("session_shutdown", async (_event, ctx) => {
		agentActive = false;
		queuedSlashCommands = [];
		sessionCtx = undefined;
		ctx.ui.setWidget("steer-hint", undefined);
	});
}
