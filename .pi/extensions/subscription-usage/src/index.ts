import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { probeCodexAnalytics } from "./analytics-client.ts";
import { normalizeCodexAnalytics, type CodexAnalyticsSnapshot } from "./analytics.ts";
import { checkCodexAuthentication } from "./auth-check.ts";
import { AnalyticsComponent, formatAnalyticsText } from "./render.ts";
import type { AnalyticsProbeResult, CodexAuthStatus } from "./types.ts";

const UsageToolParams = Type.Object({
	action: StringEnum(["status", "refresh"] as const, {
		description: "Read the latest in-memory analytics snapshot or refresh ChatGPT first",
	}),
	days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, description: "Inclusive UTC date range" })),
});

export function formatAuthStatus(status: CodexAuthStatus): string {
	const lines = [
		"Codex authentication",
		`Auth file: ${status.fileFound ? `found (${status.path})` : `not found (${status.path})`}`,
		`Access token: ${status.accessTokenPresent ? "present" : "missing"}`,
		`Account ID: ${status.accountIdPresent ? "present" : "missing"}`,
		`ChatGPT credential: ${status.credentialAccepted ? "accepted" : "not accepted"}`,
	];
	if (status.state !== "accepted") lines.push(`Next step: ${status.message}`);
	return lines.join("\n");
}

export function formatProbeResult(result: AnalyticsProbeResult): string {
	if (result.state !== "ok") {
		const checked = result.endpoints.length
			? `\nChecked: ${result.endpoints.map((endpoint) => `${endpoint.id} (${endpoint.status})`).join(", ")}`
			: "";
		return `Codex analytics probe: ${result.state}\n${result.message}${checked}`;
	}
	return [
		`Codex analytics probe: connected (${result.startDate} to ${result.endDate})`,
		...result.endpoints.map((endpoint) =>
			`- ${endpoint.id}: HTTP ${endpoint.status}${endpoint.rowCount === undefined ? "" : `, ${endpoint.rowCount} daily rows`}`,
		),
	].join("\n");
}

function dateRange(days: number, now = new Date()): { startDate: string; endDate: string } {
	const end = new Date(now);
	const start = new Date(now);
	start.setUTCDate(start.getUTCDate() - (days - 1));
	return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function parseDays(raw: string): number | undefined {
	const value = raw.trim();
	if (!value) return 30;
	const match = /^(?:refresh\s+)?(\d+)$/.exec(value);
	if (!match) return value === "refresh" ? 30 : undefined;
	const days = Number(match[1]);
	return Number.isInteger(days) && days >= 1 && days <= 90 ? days : undefined;
}

export function createSubscriptionUsageExtension(options: {
	checkAuth?: typeof checkCodexAuthentication;
	probe?: typeof probeCodexAnalytics;
} = {}) {
	return function subscriptionUsageExtension(pi: ExtensionAPI): void {
		const checkAuth = options.checkAuth ?? checkCodexAuthentication;
		const probe = options.probe ?? probeCodexAnalytics;
		let latest: CodexAnalyticsSnapshot | undefined;

		const refresh = async (days: number, signal?: AbortSignal): Promise<CodexAnalyticsSnapshot> => {
			const range = dateRange(days);
			const result = await probe({ ...range, signal });
			if (result.state !== "ok") throw new Error(formatProbeResult(result));
			const snapshot = normalizeCodexAnalytics(result);
			if (!snapshot) throw new Error("ChatGPT analytics response could not be normalized.");
			latest = snapshot;
			return snapshot;
		};

		pi.registerCommand("usage", {
			description: "Show ChatGPT Codex analytics, probe endpoints, or validate Codex authentication",
			handler: async (rawArgs, ctx) => {
				const action = rawArgs.trim().toLowerCase();
				if (action === "auth" || action === "auth status") {
					const status = await checkAuth({ signal: ctx.signal });
					ctx.ui.notify(formatAuthStatus(status), status.state === "accepted" ? "info" : "warning");
					return;
				}
				if (action === "probe") {
					const result = await probe({ signal: ctx.signal });
					ctx.ui.notify(formatProbeResult(result), result.state === "ok" ? "info" : "warning");
					return;
				}
				const days = parseDays(action);
				if (days === undefined) {
					ctx.ui.notify("Usage: /usage [refresh] [1-90] | /usage probe | /usage auth status", "error");
					return;
				}
				try {
					const snapshot = await refresh(days, ctx.signal);
					if (ctx.mode === "tui") {
						await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
							new AnalyticsComponent(snapshot, theme, () => done()), {
							overlay: true,
							overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%", margin: 1 },
						});
					} else if (ctx.hasUI) {
						ctx.ui.notify(formatAnalyticsText(snapshot), "info");
					}
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				}
			},
		});

		pi.registerTool({
			name: "subscription_usage",
			label: "ChatGPT Codex Usage",
			description: "Read normalized ChatGPT Codex analytics for the last 1-90 days. Status uses the latest in-memory snapshot when available; refresh queries ChatGPT.",
			parameters: UsageToolParams,
			async execute(_toolCallId, params, signal) {
				const snapshot = params.action === "status" && latest
					? latest
					: await refresh(params.days ?? 30, signal);
				return {
					content: [{ type: "text", text: formatAnalyticsText(snapshot) }],
					details: snapshot,
				};
			},
			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subscription_usage ")) +
						theme.fg("muted", `${args.action}${args.days ? ` · ${args.days} days` : ""}`),
					0, 0,
				);
			},
			renderResult(result, { expanded }, theme) {
				const snapshot = result.details as CodexAnalyticsSnapshot | undefined;
				if (!snapshot) {
					const content = result.content[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
				const text = expanded
					? formatAnalyticsText(snapshot)
					: `✓ ${snapshot.startDate} to ${snapshot.endDate} · ${snapshot.dailyWorkspace.length} active days`;
				return new Text(theme.fg("success", text), 0, 0);
			},
		});
	};
}

export default createSubscriptionUsageExtension();
