import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isStale } from "./probe.ts";
import type { ProbeResult } from "./probe.ts";
import { inspectCodexAuth } from "./codex-auth.ts";
import { inspectOllamaAuth } from "./ollama-auth.ts";
import { formatUsageText } from "./ollama-render.ts";
import { probeUsage } from "./ollama-client.ts";
import type { OllamaAuthInspection, UsageProbeResult, UsageSnapshot } from "./ollama-types.ts";
import { probeQuota } from "./quota-client.ts";
import { formatQuotaText } from "./render.ts";
import { styleUsageText } from "./style.ts";
import type { CodexAuthInspection, QuotaProbeResult, QuotaSnapshot } from "./types.ts";

type Provider = "codex" | "ollama" | "both";

function parseUsageArgs(raw: string): { provider: Provider; action: string } {
	const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens[0] === "codex" || tokens[0] === "ollama") {
		return { provider: tokens[0], action: tokens.slice(1).join(" ") };
	}
	return { provider: "both", action: tokens.join(" ") };
}

export function formatAuthStatus(status: CodexAuthInspection): string {
	const lines = [
		"ChatGPT Codex authentication",
		`Auth file: ${status.fileFound ? `found (${status.path})` : `not found (${status.path})`}`,
		`Access token: ${status.accessTokenPresent ? "present" : "missing"}`,
		`Account ID: ${status.accountIdPresent ? "present" : "missing"}`,
	];
	if (status.state === "ready") {
		lines.push("Credential looks usable; /usage validates it live.");
	} else {
		lines.push(`Next step: ${status.message}`);
	}
	return lines.join("\n");
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
	probe?: typeof probeQuota;
	probeOllama?: typeof probeUsage;
	inspect?: typeof inspectCodexAuth;
	inspectOllama?: typeof inspectOllamaAuth;
	now?: () => Date;
} = {}) {
	return function subscriptionUsageExtension(pi: ExtensionAPI): void {
		const probe = options.probe ?? probeQuota;
		const probeOllama = options.probeOllama ?? probeUsage;
		const inspect = options.inspect ?? inspectCodexAuth;
		const inspectOllama = options.inspectOllama ?? inspectOllamaAuth;
		const now = options.now ?? (() => new Date());
		let latestCodex: QuotaSnapshot | undefined;
		let latestOllama: UsageSnapshot | undefined;

		const fetchCodex = async (force: boolean, signal?: AbortSignal): Promise<QuotaSnapshot> => {
			if (!force && latestCodex && !isStale(latestCodex.fetchedAt, now())) return latestCodex;
			const result = await probe({ signal });
			if (result.state !== "ok") throw new Error(result.message);
			latestCodex = result.snapshot;
			return latestCodex;
		};

		const fetchOllama = async (force: boolean, signal?: AbortSignal): Promise<UsageSnapshot> => {
			if (!force && latestOllama && !isStale(latestOllama.fetchedAt, now())) return latestOllama;
			const result = await probeOllama({ signal });
			if (result.state !== "ok") throw new Error(result.message);
			latestOllama = result.snapshot;
			return latestOllama;
		};

		const runAuthStatus = async (provider: Provider, ctx: ExtensionCommandContext): Promise<void> => {
			if (provider === "codex") {
				const status = await inspect();
				ctx.ui.notify(formatAuthStatus(status), status.state === "ready" ? "info" : "warning");
				return;
			}
			if (provider === "ollama") {
				const status = await inspectOllama();
				ctx.ui.notify(formatOllamaAuthStatus(status), status.state === "ready" ? "info" : "warning");
				return;
			}
			const [codexStatus, ollamaStatus] = await Promise.all([inspect(), inspectOllama()]);
			const ready = codexStatus.state === "ready" || ollamaStatus.state === "ready";
			ctx.ui.notify(
				`${formatAuthStatus(codexStatus)}\n\n${formatOllamaAuthStatus(ollamaStatus)}`,
				ready ? "info" : "warning",
			);
		};

		const runProbe = async (provider: Provider, ctx: ExtensionCommandContext): Promise<void> => {
			if (provider === "codex") {
				const result = await probe({ signal: ctx.signal });
				ctx.ui.notify(formatProbeResult(result), result.state === "ok" ? "info" : "warning");
				return;
			}
			if (provider === "ollama") {
				const result = await probeOllama({ signal: ctx.signal });
				ctx.ui.notify(formatOllamaProbeResult(result), result.state === "ok" ? "info" : "warning");
				return;
			}
			const [codexResult, ollamaResult] = await Promise.all([
				probe({ signal: ctx.signal }),
				probeOllama({ signal: ctx.signal }),
			]);
			const ready = codexResult.state === "ok" || ollamaResult.state === "ok";
			ctx.ui.notify(
				`${formatProbeResult(codexResult)}\n${formatOllamaProbeResult(ollamaResult)}`,
				ready ? "info" : "warning",
			);
		};

		const runFetch = async (provider: Provider, force: boolean, ctx: ExtensionCommandContext): Promise<void> => {
			const captured = now();
			if (provider === "codex" || provider === "ollama") {
				try {
					const snapshot = provider === "codex"
						? await fetchCodex(force, ctx.signal)
						: await fetchOllama(force, ctx.signal);
					const text = provider === "codex"
						? formatQuotaText(snapshot, captured)
						: formatUsageText(snapshot, captured);
					ctx.ui.notify(styleUsageText(text), "info");
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				}
				return;
			}
			const results = await Promise.all([
				fetchCodex(force, ctx.signal)
					.then((snapshot) => ({ ok: true as const, text: formatQuotaText(snapshot, captured) }))
					.catch((error) => ({ ok: false as const, text: `ChatGPT Codex: ${(error as Error).message}` })),
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
