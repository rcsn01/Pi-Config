/**
 * Steer Input Extension
 *
 * Provides keyboard controls for mid-turn steering and follow-up queuing,
 * entirely within the project's extension (no global keybinding changes).
 *
 * During agent streaming, replaces the editor with a custom editor where:
 *   Enter → steer (inject message after next tool call) — built-in pi behavior
 *   Tab   → queue follow-up (message delivered after agent finishes)
 *
 * When idle, the normal editor is active and Tab/Enter behave as usual.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key } from "@earendil-works/pi-tui";

/**
 * Wraps the built-in editor to intercept Tab during agent streaming.
 * Tab reads the current text, queues it as a followUp, and clears the editor.
 * Slash-prefixed input is queued separately and submitted after the current
 * response finishes, so Pi's normal slash-command handling runs generically.
 * All other keys (including Enter → steer) pass through to the built-in editor.
 */
class SteerEditor extends CustomEditor {
	private sendFollowUp: (text: string) => void;
	private queueSlashCommand: (text: string, submit?: (text: string) => void | Promise<void>) => void;

	constructor(
		tui: Parameters<typeof CustomEditor>[0],
		theme: Parameters<typeof CustomEditor>[1],
		keybindings: Parameters<typeof CustomEditor>[2],
		sendFollowUp: (text: string) => void,
		queueSlashCommand: (text: string, submit?: (text: string) => void | Promise<void>) => void,
	) {
		super(tui, theme, keybindings);
		this.sendFollowUp = sendFollowUp;
		this.queueSlashCommand = queueSlashCommand;
	}

	override handleInput(data: string): void {
		if (matchesKey(data, Key.tab)) {
			const text = this.getText().trim();
			if (text) {
				if (text.startsWith("/")) {
					// pi.sendUserMessage(..., { deliverAs: "followUp" }) bypasses
					// slash-command parsing by design. Keep slash commands out of
					// the chat queue and submit them after the current response ends.
					this.queueSlashCommand(text, this.onSubmit);
					this.setText("");
				} else {
					this.sendFollowUp(text);
					this.setText("");
				}
			}
			return;
		}
		super.handleInput(data);
	}
}

export default function steerInputExtension(pi: ExtensionAPI) {
	let agentActive = false;
	let queuedCount = 0;
	let queuedSlashCommands: Array<{ text: string; submit?: (text: string) => void | Promise<void> }> = [];

	function updateStatus(_ctx: ExtensionContext): void {
		// Pi already shows the steering/queue hint above the editor via updateWidget().
		// Keep the footer/status area clear to avoid a duplicate hint under the chat box.
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (agentActive) {
			ctx.ui.setWidget("steer-hint", (_tui, theme) => ({
				render: () => [theme.fg("dim", "↩ Enter → steer    ⇥ Tab → queue for next turn")],
				invalidate: () => {},
			}));
		} else {
			ctx.ui.setWidget("steer-hint", undefined);
		}
	}

	// ---- Agent lifecycle: swap editors ----
	pi.on("agent_start", async (_event, ctx) => {
		agentActive = true;
		queuedCount = 0;
		updateStatus(ctx);
		updateWidget(ctx);

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			return new SteerEditor(
				tui,
				theme,
				keybindings,
				(text) => {
					pi.sendUserMessage(text, { deliverAs: "followUp" });
					queuedCount++;
					ctx.ui.notify(
						`Queued for next turn${queuedCount > 1 ? ` (${queuedCount} pending)` : ""}`,
						"info",
					);
				},
				(text, submit) => {
					queuedSlashCommands.push({ text, submit });
					queuedCount++;
					ctx.ui.notify(
						`Queued slash command for after this response${queuedSlashCommands.length > 1 ? ` (${queuedSlashCommands.length} pending)` : ""}`,
						"info",
					);
				},
			);
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentActive = false;
		ctx.ui.setEditorComponent(undefined);
		updateStatus(ctx);
		updateWidget(ctx);

		const slashCommands = queuedSlashCommands;
		queuedSlashCommands = [];
		for (const { text, submit } of slashCommands) {
			if (submit) {
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

	// ---- Reload / shutdown cleanup ----
	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
		if (agentActive) updateWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		agentActive = false;
		queuedSlashCommands = [];
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setWidget("steer-hint", undefined);
	});
}
