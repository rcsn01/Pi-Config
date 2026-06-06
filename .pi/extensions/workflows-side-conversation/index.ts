/**
 * Side Mode Extension - `/side` toggles between main and side conversations
 *
 * From a main conversation, `/side` creates a marked child session with the
 * current resolved conversation context and switches into it.
 *
 * From a marked side conversation, `/side` switches back to the parent session.
 *
 * Commands:
 *   /side                    - Enter side mode, or exit side mode if already there
 *   /side <prompt>           - Enter side mode and immediately run the inline prompt
 */

import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { CustomEntry, ExtensionAPI, ExtensionContext, ReplacedSessionContext } from "@earendil-works/pi-coding-agent";

const SIDE_MARKER_TYPE = "side-mode-session";
const SIDE_STATUS_ID = "side-mode";
const SIDE_STATUS_TEXT = "currently in /side mode, /side to exit.";

function isSideModeSession(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getEntries()
		.some((entry) => entry.type === "custom" && entry.customType === SIDE_MARKER_TYPE);
}

function updateSideModeStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(SIDE_STATUS_ID, isSideModeSession(ctx) ? SIDE_STATUS_TEXT : undefined);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => updateSideModeStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => updateSideModeStatus(ctx));

	pi.registerCommand("side", {
		description: "Toggle side mode: start a marked side conversation, or return to main from side",
		handler: async (args, ctx) => {
			const prompt = (args || "").trim();

			try {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the current turn before toggling side mode...", "info");
					await ctx.waitForIdle();
				}

				const parentSession = ctx.sessionManager.getHeader()?.parentSession;

				// Only sessions explicitly created by this extension count as side mode.
				// Ordinary pi forks/clones also have parentSession, so using parentSession
				// alone makes the footer and /side behavior lie in non-side sessions.
				if (parentSession && isSideModeSession(ctx)) {
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

				const currentSessionFile = ctx.sessionManager.getSessionFile();
				if (!currentSessionFile) {
					ctx.ui.notify("Side mode needs a persisted main session to return to.", "warning");
					return;
				}

				const currentMessages = buildSessionContext(
					ctx.sessionManager.getEntries(),
					ctx.sessionManager.getLeafId(),
				).messages;
				const currentCustomEntries = ctx.sessionManager
					.getBranch()
					.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType !== SIDE_MARKER_TYPE);

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

				const result = await ctx.newSession({
					parentSession: currentSessionFile,
					setup: async (sessionManager) => {
						for (const message of currentMessages) {
							sessionManager.appendMessage(message);
						}
						for (const entry of currentCustomEntries) {
							sessionManager.appendCustomEntry(entry.customType, entry.data);
						}
						sessionManager.appendCustomEntry(SIDE_MARKER_TYPE, {
							parentSession: currentSessionFile,
							createdAt: new Date().toISOString(),
						});
					},
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
