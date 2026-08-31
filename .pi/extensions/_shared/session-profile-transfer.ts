import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PROFILES_ENTRY_TYPE, validateProfileName } from "./profile-document.ts";
import type { SessionProfileBinding } from "./session-profile-binding.ts";

type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
export type FreshSessionContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

export interface SessionProfileTransferOptions {
	readonly withFreshSession?: (ctx: FreshSessionContext) => void | Promise<void>;
}

export type SessionProfileTransferResult =
	| { readonly status: "started" }
	| { readonly status: "cancelled" };

export interface SessionProfileTransfer {
	openFreshSession(
		ctx: ExtensionCommandContext,
		binding: SessionProfileBinding,
		options?: SessionProfileTransferOptions,
	): Promise<SessionProfileTransferResult>;
}

export interface SessionProfileHandoff {
	readonly token: symbol;
	readonly previousSessionFile?: string;
	readonly profileName?: string;
}

interface SessionProfileTransferRegistry {
	active?: SessionProfileHandoff;
}

const SESSION_PROFILE_TRANSFER_KEY = Symbol.for("pi.extensions.session-profile-transfer.v1");

function transferRegistry(): SessionProfileTransferRegistry {
	const globals = globalThis as typeof globalThis & {
		[SESSION_PROFILE_TRANSFER_KEY]?: SessionProfileTransferRegistry;
	};
	return globals[SESSION_PROFILE_TRANSFER_KEY] ??= {};
}

/** Internal seam used by Session profile binding during `session_start`. */
export function readSessionProfileHandoff(
	previousSessionFile: string | undefined,
): SessionProfileHandoff | undefined {
	const handoff = transferRegistry().active;
	if (!handoff || handoff.previousSessionFile !== previousSessionFile) return undefined;
	return handoff;
}

function stageSessionProfileHandoff(
	previousSessionFile: string | undefined,
	profileName: string | undefined,
): SessionProfileHandoff {
	const registry = transferRegistry();
	if (registry.active) throw new Error("A Session profile transfer is already in progress.");
	const handoff: SessionProfileHandoff = Object.freeze({
		token: Symbol("session-profile-transfer"),
		previousSessionFile,
		profileName: profileName === undefined ? undefined : validateProfileName(profileName),
	});
	registry.active = handoff;
	return handoff;
}

function clearSessionProfileHandoff(handoff: SessionProfileHandoff): void {
	const registry = transferRegistry();
	if (registry.active?.token === handoff.token) delete registry.active;
}

export function createSessionProfileTransfer(): SessionProfileTransfer {
	return {
		async openFreshSession(ctx, binding, options = {}) {
			const parentSession = ctx.sessionManager.getSessionFile() || undefined;
			const handoff = stageSessionProfileHandoff(parentSession, binding.profileName);
			try {
				const result = await ctx.newSession({
					parentSession,
					setup: async (sessionManager) => {
						if (binding.profileName !== undefined) {
							sessionManager.appendCustomEntry(CONFIG_PROFILES_ENTRY_TYPE, {
								active: binding.profileName,
							});
						}
					},
					...(options.withFreshSession
						? { withSession: async (freshCtx) => { await options.withFreshSession!(freshCtx); } }
						: {}),
				});
				return { status: result.cancelled ? "cancelled" : "started" };
			} finally {
				clearSessionProfileHandoff(handoff);
			}
		},
	};
}

export const sessionProfileTransfer = createSessionProfileTransfer();
