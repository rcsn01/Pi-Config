import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CodexCredentialSlotError } from "../../provider-codex/credential-slots.ts";
import {
	CodexSlotUsageClient,
	formatCodexAuthStatus,
	formatCodexProbeResults,
	type CodexSlotUsageClientLike,
} from "./codex-slots.ts";
import { isStale } from "./probe.ts";
import type { ProbeResult } from "./probe.ts";
import { inspectOllamaAuth } from "./ollama-auth.ts";
import { formatUsageText } from "./ollama-render.ts";
import { probeUsage } from "./ollama-client.ts";
import type { OllamaAuthInspection, UsageProbeResult, UsageSnapshot } from "./ollama-types.ts";
import { styleUsageText } from "./style.ts";
import type { QuotaProbeResult } from "./types.ts";

export { formatCodexAuthStatus, formatCodexProbeResults } from "./codex-slots.ts";

type Provider = "codex" | "ollama" | "both";

function parseUsageArgs(raw: string): { provider: Provider; action: string } {
	const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens[0] === "codex" || tokens[0] === "ollama") {
		return { provider: tokens[0], action: tokens.slice(1).join(" ") };
	}
	return { provider: "both", action: tokens.join(" ") };
}

function safeCodexError(error: unknown): string {
	if (!(error instanceof CodexCredentialSlotError)) return "Could not read Codex credential slots.";
	switch (error.code) {
		case "INVALID_STATE":
			return "Codex credential slot state is invalid.";
		case "INVALID_AUTH":
			return "Codex credential data is invalid.";
		default:
			return "Could not read Codex credential slots.";
	}
}

export function formatOllamaAuthStatus(status: OllamaAuthInspection): string {
	const lines = [
		"Ollama Cloud authentication",
		`Key file: ${status.fileFound ? `found (${status.path})` : `not found (${status.path})`}`,
	];
	if (status.state === "ready") {
		lines.push("Ed25519 key parses and can sign; /usage validates it live.");
	} else {
		lines.push(`Next step: ${status.message}`);
	}
	return lines.join("\n");
}

function formatProbeResultText(probeLabel: string, result: ProbeResult<{ plan?: string }>): string {
	if (result.state === "ok") {
		return `${probeLabel}: connected · plan ${result.snapshot.plan ?? "unknown"}`;
	}
	return `${probeLabel}: ${result.state}\n${result.message}`;
}

export function formatProbeResult(result: QuotaProbeResult): string {
	return formatProbeResultText("Codex quota probe", result);
}

export function formatOllamaProbeResult(result: UsageProbeResult): string {
	return formatProbeResultText("Ollama usage probe", result);
}

export function createSubscriptionUsageExtension(options: {
		codex?: CodexSlotUsageClientLike;
		probeOllama?: typeof probeUsage;
		inspectOllama?: typeof inspectOllamaAuth;
		now?: () => Date;
} = {}) {
	return function subscriptionUsageExtension(pi: ExtensionAPI): void {
		const now = options.now ?? (() => new Date());
		// The current login needs only runtime metadata. Do not open or initialize
		// the legacy credential store unless a legacy action is actually requested.
		let codex = options.codex;
		const legacyCodex = () => codex ??= new CodexSlotUsageClient({ now });
		const probeOllama = options.probeOllama ?? probeUsage;
		const inspectOllama = options.inspectOllama ?? inspectOllamaAuth;
		let latestOllama: UsageSnapshot | undefined;

		const readCodex = async (
			ctx: ExtensionCommandContext,
			action: string,
			captured: Date,
		): Promise<{ ok: boolean; text: string }> => {
			const openaiModel = ctx.modelRegistry.getAll().find((model) => model.provider === "openai");
			if (openaiModel && ctx.modelRegistry.isUsingOAuth(openaiModel)) {
				// SIWC tokens target api.openai.com and contain opaque auth metadata,
				// not the account ID required by the legacy backend-api quota probe.
				return {
					ok: true,
					text: [
						"ChatGPT subscription · OpenAI",
						"Authentication: Sign in with ChatGPT (/login openai)",
						"Quota data is not available through this integration for the current login.",
						"Manage usage: https://chatgpt.com/settings/usage",
					].join("\n"),
				};
			}
			try {
				if (action === "auth status") {
					const inspection = legacyCodex().inspect();
					return {
						ok: inspection.slots.some((slot) => slot.hasCredential),
						text: formatCodexAuthStatus(inspection),
					};
				}
				const batch = await legacyCodex().query({
					cache: action === "probe" ? "bypass" : action === "refresh" ? "refresh" : "prefer",
					signal: ctx.signal,
				});
				return { ok: batch.anySuccess, text: formatCodexProbeResults(batch, captured) };
			} catch (error) {
				return { ok: false, text: safeCodexError(error) };
			}
		};

		const readOllama = async (
			ctx: ExtensionCommandContext,
			action: string,
			captured: Date,
			inspection?: OllamaAuthInspection,
		): Promise<{ ok: boolean; text: string }> => {
			if (action === "auth status") {
				const status = inspection ?? await inspectOllama();
				return { ok: status.state === "ready", text: formatOllamaAuthStatus(status) };
			}
			if (action === "probe") {
				const result = await probeOllama({ signal: ctx.signal });
				return { ok: result.state === "ok", text: formatOllamaProbeResult(result) };
			}
			try {
				if (action !== "refresh" && latestOllama && !isStale(latestOllama.fetchedAt, captured)) {
					return { ok: true, text: formatUsageText(latestOllama, captured) };
				}
				const result = await probeOllama({ signal: ctx.signal });
				if (result.state !== "ok") throw new Error(result.message);
				latestOllama = result.snapshot;
				return { ok: true, text: formatUsageText(latestOllama, captured) };
			} catch (error) {
				return { ok: false, text: (error as Error).message };
			}
		};

		pi.registerCommand("usage", {
			description: "Show ChatGPT subscription status, legacy Codex quota, and configured Ollama usage",
			handler: async (rawArgs, ctx) => {
				const { provider, action } = parseUsageArgs(rawArgs);
				const normalized = action === "auth" ? "auth status" : action;
				if (!["", "refresh", "probe", "auth status"].includes(normalized)) {
					ctx.ui.notify(
						"Usage: /usage [codex|ollama] [refresh] | /usage [codex|ollama] probe | /usage [codex|ollama] auth status",
						"error",
					);
					return;
				}
				const captured = now();
				const ollamaStatus = provider === "both" ? await inspectOllama() : undefined;
				const includeOllama = provider === "ollama" || (provider === "both" && ollamaStatus?.state !== "missing");
				if (ollamaStatus?.state === "missing") latestOllama = undefined;
				const requests: Array<Promise<{ ok: boolean; text: string }>> = [];
				if (provider !== "ollama") requests.push(readCodex(ctx, normalized, captured));
				if (includeOllama) {
					requests.push(readOllama(ctx, normalized, captured, ollamaStatus).then((result) => ({
						...result,
						text: provider === "both" && !result.ok && normalized !== "probe" && normalized !== "auth status"
							? `Ollama Cloud: ${result.text}` : result.text,
					})));
				}
				const results = await Promise.all(requests);
				const ready = results.some((result) => result.ok);
				const failureLevel = normalized === "probe" || normalized === "auth status" ? "warning" : "error";
				ctx.ui.notify(styleUsageText(results.map((result) => result.text).join("\n\n")), ready ? "info" : failureLevel);
			},
		});
	};
}

export default createSubscriptionUsageExtension();
