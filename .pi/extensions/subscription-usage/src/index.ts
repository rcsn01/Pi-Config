import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { inspectCodexAuth } from "./codex-auth.ts";
import { inspectOllamaAuth } from "./ollama-auth.ts";
import { formatUsageText } from "./ollama-render.ts";
import { isUsageStale } from "./ollama-usage.ts";
import { probeUsage } from "./ollama-client.ts";
import type { OllamaAuthInspection, UsageProbeResult, UsageSnapshot } from "./ollama-types.ts";
import { isSnapshotStale } from "./quota.ts";
import { probeQuota } from "./quota-client.ts";
import { formatQuotaText } from "./render.ts";
import { styleUsageText } from "./style.ts";
import { renderToolSummary } from "../../_shared/tool-result-ui.ts";
import type { CodexAuthInspection, QuotaProbeResult, QuotaSnapshot } from "./types.ts";

const UsageToolParams = Type.Object({
	action: StringEnum(["status", "refresh"] as const, {
		description: "Read the latest in-memory snapshot or query the provider first",
	}),
});

type Provider = "codex" | "ollama" | "both";

const USAGE_BAR = /\[[█░]+\]/g;
const USAGE_PERCENT = /(\d+(?:\.\d+)?% used)/g;

function renderUsageText(text: string, theme: Theme): Text {
	const lines = text.split("\n").map((line) => {
		if (/^(ChatGPT Codex|Ollama Cloud)/.test(line)) {
			return theme.fg("accent", theme.bold(line));
		}
		let styled = line.replace(USAGE_BAR, (bar: string) => theme.fg("accent", theme.bold(bar)));
		styled = styled.replace(USAGE_PERCENT, (share: string) => theme.bold(share));
		return theme.fg("toolOutput", styled);
	});
	return new Text(lines.join("\n"), 0, 0);
}

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

export function formatProbeResult(result: QuotaProbeResult): string {
	if (result.state === "ok") {
		return `Codex quota probe: connected · plan ${result.snapshot.plan ?? "unknown"}`;
	}
	return `Codex quota probe: ${result.state}\n${result.message}`;
}

export function formatOllamaProbeResult(result: UsageProbeResult): string {
	if (result.state === "ok") {
		return `Ollama usage probe: connected · plan ${result.snapshot.plan ?? "unknown"}`;
	}
	return `Ollama usage probe: ${result.state}\n${result.message}`;
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
			if (!force && latestCodex && !isSnapshotStale(latestCodex.fetchedAt, now())) return latestCodex;
			const result = await probe({ signal });
			if (result.state !== "ok") throw new Error(result.message);
			latestCodex = result.snapshot;
			return latestCodex;
		};

		const fetchOllama = async (force: boolean, signal?: AbortSignal): Promise<UsageSnapshot> => {
			if (!force && latestOllama && !isUsageStale(latestOllama.fetchedAt, now())) return latestOllama;
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

		pi.registerTool({
			name: "subscription_usage",
			label: "ChatGPT Codex Usage",
			description: "Read the ChatGPT Codex quota (plan, weekly limit, rate-limit reset credits). Status uses the latest in-memory snapshot when available; refresh queries ChatGPT.",
			parameters: UsageToolParams,
			async execute(_toolCallId, params, signal) {
				const snapshot = await fetchCodex(params.action === "refresh", signal);
				return {
					content: [{ type: "text", text: formatQuotaText(snapshot, now()) }],
					details: snapshot,
				};
			},
			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subscription_usage ")) +
						theme.fg("muted", args.action),
					0, 0,
				);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return renderToolSummary(theme, "running", "Loading Codex usage…");
				if (context.isError) {
					const message = result.content.find((content) => content.type === "text")?.text ?? "Usage request failed.";
					return renderToolSummary(theme, "error", message);
				}
				const snapshot = result.details as QuotaSnapshot | undefined;
				if (!snapshot) {
					const content = result.content[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
				const summary = snapshot.weekly
					? `${Math.round(snapshot.weekly.usedPercent)}% of weekly limit used`
					: "weekly limit unavailable";
				if (!expanded) return renderToolSummary(theme, "success", `Plan ${snapshot.plan ?? "unknown"} · ${summary}`, true);
				return renderUsageText(formatQuotaText(snapshot, new Date()), theme);
			},
		});

		pi.registerTool({
			name: "ollama_usage",
			label: "Ollama Cloud Usage",
			description: "Read the Ollama Cloud session and weekly usage from the authenticated Ollama key. Status uses the latest in-memory snapshot when available; refresh queries ollama.com.",
			parameters: UsageToolParams,
			async execute(_toolCallId, params, signal) {
				const snapshot = await fetchOllama(params.action === "refresh", signal);
				return {
					content: [{ type: "text", text: formatUsageText(snapshot, now()) }],
					details: snapshot,
				};
			},
			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("ollama_usage ")) +
						theme.fg("muted", args.action),
					0, 0,
				);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return renderToolSummary(theme, "running", "Loading Ollama usage…");
				if (context.isError) {
					const message = result.content.find((content) => content.type === "text")?.text ?? "Usage request failed.";
					return renderToolSummary(theme, "error", message);
				}
				const snapshot = result.details as UsageSnapshot | undefined;
				if (!snapshot) {
					const content = result.content[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
				const summary = snapshot.weekly
					? `${Math.round(snapshot.weekly.usedPercent)}% of weekly usage used`
					: "weekly usage unavailable";
				if (!expanded) return renderToolSummary(theme, "success", summary, true);
				return renderUsageText(formatUsageText(snapshot, new Date()), theme);
			},
		});
	};
}

export default createSubscriptionUsageExtension();
