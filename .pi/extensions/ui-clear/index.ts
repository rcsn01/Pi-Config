/**
 * Clear Extension - clear terminal output and start a fresh Pi Session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerSessionProfileBinding,
	type SessionProfileBinding,
} from "../_shared/session-profile-binding.ts";
import {
	sessionProfileTransfer,
	type SessionProfileTransfer,
} from "../_shared/session-profile-transfer.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";

export interface ClearExtensionDependencies {
	readonly settingsPath?: string;
	readonly sessionProfileTransfer?: SessionProfileTransfer;
}

interface CapturedSessionProfileBinding {
	readonly binding: SessionProfileBinding;
	readonly sessionId: string;
}

export function createClearExtension(dependencies: ClearExtensionDependencies = {}) {
	return function clearExtension(pi: ExtensionAPI): void {
		const settingsPath = dependencies.settingsPath ?? PROJECT_SETTINGS_PATH;
		const transfer = dependencies.sessionProfileTransfer ?? sessionProfileTransfer;
		let captured: CapturedSessionProfileBinding | undefined;

		const profileInitialization = registerSessionProfileBinding(
			{ settingsPath },
			{
				name: "ui-clear",
				initialize: (binding, _event, ctx) => {
					captured = { binding, sessionId: ctx.sessionManager.getSessionId() };
				},
				dispose: (binding, ctx) => {
					if (
						captured?.binding === binding &&
						captured.sessionId === ctx.sessionManager.getSessionId()
					) captured = undefined;
				},
			},
		);

		pi.registerCommand("clear", {
			description: "clear all terminal output and start a fresh session",
			handler: async (_args, ctx) => {
				const active = captured;
				if (!active || active.sessionId !== ctx.sessionManager.getSessionId()) {
					ctx.ui.notify("Cannot clear because the Session profile binding is unavailable.", "error");
					return;
				}

				process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
				try {
					const result = await transfer.openFreshSession(ctx, active.binding, {
						withFreshSession: (freshCtx) => {
							freshCtx.ui.notify(
								"Terminal cleared. Fresh session started. Previous session resumable via /resume.",
								"info",
							);
						},
					});
					if (result.status === "cancelled") ctx.ui.notify("Clear cancelled.", "info");
				} catch (error) {
					ctx.ui.notify(
						`Cleared terminal but couldn't start new session: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.on("session_start", async (event, ctx) => {
			await profileInitialization.start(event, ctx);
		});
		pi.on("session_shutdown", async (event, ctx) => {
			try {
				await profileInitialization.stop(event, ctx);
			} finally {
				profileInitialization.unregister();
			}
		});
	};
}

export default createClearExtension();
