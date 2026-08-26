import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CodexCredentialSlotError } from "../../provider-codex/credential-slots.ts";
import {
	CodexSlotUsageClient,
	formatCodexAuthStatus,
	formatCodexProbeResults,
	type CodexSlotQuotaBatch,
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
		const codex = options.codex ?? new CodexSlotUsageClient({ now });
		const probeOllama = options.probeOllama ?? probeUsage;
		const inspectOllama = options.inspectOllama ?? inspectOllamaAuth;
		let latestOllama: UsageSnapshot | undefined;

		const fetchCodex = async (force: boolean, signal?: AbortSignal): Promise<CodexSlotQuotaBatch> =>
			codex.query({ cache: force ? "refresh" : "prefer", signal });

		const fetchOllama = async (force: boolean, signal?: AbortSignal): Promise<UsageSnapshot> => {
			if (!force && latestOllama && !isStale(latestOllama.fetchedAt, now())) return latestOllama;
			const result = await probeOllama({ signal });
			if (result.state !== "ok") throw new Error(result.message);
			latestOllama = result.snapshot;
			return latestOllama;
		};

		const runAuthStatus = async (provider: Provider, ctx: ExtensionCommandContext): Promise<void> => {
			if (provider === "codex") {
				try {
					const inspection = codex.inspect();
					const hasCredential = inspection.slots.some((slot) => slot.hasCredential);
					ctx.ui.notify(formatCodexAuthStatus(inspection), hasCredential ? "info" : "warning");
				} catch (error) {
					ctx.ui.notify(safeCodexError(error), "warning");
				}
				return;
			}
			if (provider === "ollama") {
				const status = await inspectOllama();
				ctx.ui.notify(formatOllamaAuthStatus(status), status.state === "ready" ? "info" : "warning");
				return;
			}

			let codexText: string;
			let codexReady = false;
			try {
				const inspection = codex.inspect();
				codexText = formatCodexAuthStatus(inspection);
				codexReady = inspection.slots.some((slot) => slot.hasCredential);
			} catch (error) {
				codexText = safeCodexError(error);
			}
			const ollamaStatus = await inspectOllama();
			ctx.ui.notify(
				`${codexText}\n\n${formatOllamaAuthStatus(ollamaStatus)}`,
				codexReady || ollamaStatus.state === "ready" ? "info" : "warning",
			);
		};

		const runProbe = async (provider: Provider, ctx: ExtensionCommandContext): Promise<void> => {
			if (provider === "codex") {
				const batch = await codex.query({ cache: "bypass", signal: ctx.signal });
				ctx.ui.notify(
					formatCodexProbeResults(batch, now()),
					batch.anySuccess ? "info" : "warning",
				);
				return;
			}
			if (provider === "ollama") {
				const result = await probeOllama({ signal: ctx.signal });
				ctx.ui.notify(formatOllamaProbeResult(result), result.state === "ok" ? "info" : "warning");
				return;
			}
			const [codexResult, ollamaResult] = await Promise.all([
				codex.query({ cache: "bypass", signal: ctx.signal }),
				probeOllama({ signal: ctx.signal }),
			]);
			const ready = codexResult.anySuccess || ollamaResult.state === "ok";
			ctx.ui.notify(
				`${formatCodexProbeResults(codexResult, now())}\n${formatOllamaProbeResult(ollamaResult)}`,
				ready ? "info" : "warning",
			);
		};

		const runFetch = async (provider: Provider, force: boolean, ctx: ExtensionCommandContext): Promise<void> => {
			const captured = now();
			if (provider === "codex") {
				try {
					const batch = await fetchCodex(force, ctx.signal);
					ctx.ui.notify(
						styleUsageText(formatCodexProbeResults(batch, captured)),
						batch.anySuccess ? "info" : "error",
					);
				} catch (error) {
					ctx.ui.notify(safeCodexError(error), "error");
				}
				return;
			}
			if (provider === "ollama") {
				try {
					const snapshot = await fetchOllama(force, ctx.signal);
					ctx.ui.notify(styleUsageText(formatUsageText(snapshot, captured)), "info");
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				}
				return;
			}
			const results = await Promise.all([
				fetchCodex(force, ctx.signal)
					.then((batch) => ({ ok: batch.anySuccess, text: formatCodexProbeResults(batch, captured) }))
					.catch((error) => ({ ok: false as const, text: `ChatGPT Codex: ${safeCodexError(error)}` })),
				fetchOllama(force, ctx.signal)
					.then((snapshot) => ({ ok: true as const, text: formatUsageText(snapshot, captured) }))
					.catch((error) => ({ ok: false as const, text: `Ollama Cloud: ${(error as Error).message}` })),
			]);
			const ready = results.some((result) => result.ok);
			ctx.ui.notify(styleUsageText(results.map((result) => result.text).join("\n\n")), ready ? "info" : "error");
		};

		pi.registerCommand("usage", {
			description: "Show ChatGPT Codex quota and Ollama Cloud usage (plan, limits, resets)",
			handler: async (rawArgs, ctx) => {
				const { provider, action } = parseUsageArgs(rawArgs);
				const normalized = action === "auth" ? "auth status" : action;
				if (normalized === "auth status") {
					await runAuthStatus(provider, ctx);
					return;
				}
				if (normalized === "probe") {
					await runProbe(provider, ctx);
					return;
				}
				if (normalized !== "" && normalized !== "refresh") {
					ctx.ui.notify(
						"Usage: /usage [codex|ollama] [refresh] | /usage [codex|ollama] probe | /usage [codex|ollama] auth status",
						"error",
					);
					return;
				}
				await runFetch(provider, normalized === "refresh", ctx);
			},
		});
	};
}

export default createSubscriptionUsageExtension();
