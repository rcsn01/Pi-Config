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
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import {
	getModelCommandHandler,
	ModelCommandRoutingEditor,
	parseModelCommand,
} from "../_shared/model-command-routing.ts";

/**
 * Wraps the built-in editor to intercept Tab during agent streaming.
 * Tab reads the current text, queues it as a followUp, and clears the editor.
 * Slash-prefixed input is queued separately and submitted after the current
 * response finishes, so Pi's normal slash-command handling runs generically.
 * When the custom model selector is enabled, /model invokes it directly both
 * on Enter and while queued. All other keys pass through to the built-in editor.
 */
class SteerEditor extends ModelCommandRoutingEditor {
	private sendFollowUp: (text: string) => void;
	private queueSlashCommand: (text: string, submit?: (text: string) => void | Promise<void>) => void;

	constructor(
		tui: ConstructorParameters<typeof ModelCommandRoutingEditor>[0],
		theme: ConstructorParameters<typeof ModelCommandRoutingEditor>[1],
		keybindings: ConstructorParameters<typeof ModelCommandRoutingEditor>[2],
		modelCommandHandler: ReturnType<typeof getModelCommandHandler>,
		sendFollowUp: (text: string) => void,
		queueSlashCommand: (text: string, submit?: (text: string) => void | Promise<void>) => void,
	) {
		super(tui, theme, keybindings, modelCommandHandler);
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
	let queuedSlashCommands: Array<{
		text: string;
		submit?: (text: string) => void | Promise<void>;
		run?: () => Promise<void>;
	}> = [];
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	function updateStatus(_ctx: ExtensionContext): void {
		// Pi already shows the steering/queue hint above the editor via updateWidget().
		// Keep the footer/status area clear to avoid a duplicate hint under the chat box.
	}

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

	// ---- Agent lifecycle: swap editors ----
	pi.on("agent_start", async (_event, ctx) => {
		agentActive = true;
		queuedCount = 0;
		updateStatus(ctx);
		updateWidget(ctx);
		previousEditorFactory = ctx.ui.getEditorComponent();
		const modelCommandHandler = getModelCommandHandler();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			return new SteerEditor(
				tui,
				theme,
				keybindings,
				modelCommandHandler,
				(text) => {
					pi.sendUserMessage(text, { deliverAs: "followUp" });
					queuedCount++;
					ctx.ui.notify(
						`Queued for next turn${queuedCount > 1 ? ` (${queuedCount} pending)` : ""}`,
						"info",
					);
				},
				(text, submit) => {
					const modelArgs = modelCommandHandler ? parseModelCommand(text) : undefined;
					if (modelCommandHandler && modelArgs !== undefined) {
						queuedSlashCommands.push({
							text,
							run: () => modelCommandHandler(modelArgs),
						});
					} else {
						queuedSlashCommands.push({ text, submit });
					}
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
		ctx.ui.setEditorComponent(previousEditorFactory);
		previousEditorFactory = undefined;
		updateStatus(ctx);
		updateWidget(ctx);

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

	// ---- Reload / shutdown cleanup ----
	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
		if (agentActive) updateWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		agentActive = false;
		queuedSlashCommands = [];
		previousEditorFactory = undefined;
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setWidget("steer-hint", undefined);
	});
}
