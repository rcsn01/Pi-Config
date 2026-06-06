/**
 * Side Mode Extension - `/side` toggles between main and side conversations
 *
 * From a main conversation, `/side` forks the current session path and switches
 * into that fork. The side session knows the main conversation up to the fork
 * point because it is created from the current leaf.
 *
 * From a side/forked conversation, `/side` switches back to the parent session.
 *
 * Commands:
 *   /side                    - Enter side mode, or exit side mode if already there
 *   /side <prompt>           - Enter side mode and immediately run the inline prompt
 */

import type { ExtensionAPI, ExtensionContext, ReplacedSessionContext } from "@earendil-works/pi-coding-agent";

const SIDE_STATUS_ID = "side-mode";
const SIDE_STATUS_TEXT = "currently in /side mode, /side to exit.";

function updateSideModeStatus(ctx: ExtensionContext): void {
	const inSideMode = Boolean(ctx.sessionManager.getHeader()?.parentSession);
	ctx.ui.setStatus(SIDE_STATUS_ID, inSideMode ? SIDE_STATUS_TEXT : undefined);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => updateSideModeStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => updateSideModeStatus(ctx));

	pi.registerCommand("side", {
		description: "Toggle side mode: fork from main, or return to main from side",
		handler: async (args, ctx) => {
			const prompt = (args || "").trim();

			try {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the current turn before toggling side mode...", "info");
					await ctx.waitForIdle();
				}

				const parentSession = ctx.sessionManager.getHeader()?.parentSession;

				// If this session was created as a fork/side session, /side exits back to main.
				if (parentSession) {
					const result = await ctx.switchSession(parentSession, {
						withSession: async (mainCtx: ReplacedSessionContext) => {
							updateSideModeStatus(mainCtx);
							mainCtx.ui.notify("↩ Returned to main conversation.", "info");
						},
					});

					if (result.cancelled) {
						ctx.ui.notify("Return to main conversation cancelled.", "info");
					}
					return;
				}

				const currentLeafId = ctx.sessionManager.getLeafId();
				if (!currentLeafId) {
					ctx.ui.notify("No conversation to enter side mode from.", "warning");
					return;
				}

				const withSideSession = async (sideCtx: ReplacedSessionContext) => {
					updateSideModeStatus(sideCtx);
					sideCtx.ui.notify(
						"⚡ Side mode active. Use /side again to return to the main conversation.",
						"info",
					);

					if (prompt) {
						await sideCtx.sendUserMessage(prompt);
					} else {
						sideCtx.ui.notify("Type your side question or task.", "info");
					}
				};

				const result = await ctx.fork(currentLeafId, {
					position: "at",
					withSession: withSideSession,
				});

				if (result.cancelled) {
					ctx.ui.notify("Side mode cancelled.", "info");
				}
			} catch (error) {
				ctx.ui.notify(`Failed to toggle side mode: ${getErrorMessage(error)}`, "error");
			}
		},
	});
}
