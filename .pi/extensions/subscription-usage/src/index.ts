import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { inspectCodexAuth } from "./codex-auth.ts";
import { isSnapshotStale } from "./quota.ts";
import { probeQuota } from "./quota-client.ts";
import { formatQuotaText } from "./render.ts";
import type { CodexAuthInspection, QuotaProbeResult, QuotaSnapshot } from "./types.ts";

const UsageToolParams = Type.Object({
	action: StringEnum(["status", "refresh"] as const, {
		description: "Read the latest in-memory quota snapshot or refresh ChatGPT first",
	}),
});

export function formatAuthStatus(status: CodexAuthInspection): string {
	const lines = [
		"Codex authentication",
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

export function formatProbeResult(result: QuotaProbeResult): string {
	if (result.state === "ok") {
		return `Codex quota probe: connected · plan ${result.snapshot.plan ?? "unknown"}`;
	}
	return `Codex quota probe: ${result.state}\n${result.message}`;
}

export function createSubscriptionUsageExtension(options: {
	probe?: typeof probeQuota;
	inspect?: typeof inspectCodexAuth;
	now?: () => Date;
} = {}) {
	return function subscriptionUsageExtension(pi: ExtensionAPI): void {
		const probe = options.probe ?? probeQuota;
		const inspect = options.inspect ?? inspectCodexAuth;
		const now = options.now ?? (() => new Date());
		let latest: QuotaSnapshot | undefined;

		const fresh = (): QuotaSnapshot | undefined =>
			latest && !isSnapshotStale(latest.fetchedAt, now()) ? latest : undefined;

		const refresh = async (signal?: AbortSignal): Promise<QuotaSnapshot> => {
			const result = await probe({ signal });
			if (result.state !== "ok") throw new Error(result.message);
			latest = result.snapshot;
			return latest;
		};

		pi.registerCommand("usage", {
			description: "Show the ChatGPT Codex quota (plan, weekly limit, reset credits)",
			handler: async (rawArgs, ctx) => {
				const action = rawArgs.trim().toLowerCase();
				if (action === "auth" || action === "auth status") {
					const status = await inspect();
					ctx.ui.notify(formatAuthStatus(status), status.state === "ready" ? "info" : "warning");
					return;
				}
				if (action === "probe") {
					const result = await probe({ signal: ctx.signal });
					ctx.ui.notify(formatProbeResult(result), result.state === "ok" ? "info" : "warning");
					return;
				}
				if (action !== "" && action !== "refresh") {
					ctx.ui.notify("Usage: /usage [refresh] | /usage probe | /usage auth status", "error");
					return;
				}
				try {
					const snapshot = action === "refresh" ? undefined : fresh();
					ctx.ui.notify(formatQuotaText(snapshot ?? await refresh(ctx.signal)), "info");
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				}
			},
		});

		pi.registerTool({
			name: "subscription_usage",
			label: "ChatGPT Codex Usage",
			description: "Read the ChatGPT Codex quota (plan, weekly limit, rate-limit reset credits). Status uses the latest in-memory snapshot when available; refresh queries ChatGPT.",
			parameters: UsageToolParams,
			async execute(_toolCallId, params, signal) {
				const snapshot = params.action === "status"
					? fresh() ?? await refresh(signal)
					: await refresh(signal);
				return {
					content: [{ type: "text", text: formatQuotaText(snapshot) }],
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
			renderResult(result, { expanded }, theme) {
				const snapshot = result.details as QuotaSnapshot | undefined;
				if (!snapshot) {
					const content = result.content[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
				const summary = snapshot.weekly
					? `${Math.round(snapshot.weekly.usedPercent)}% of weekly limit used`
					: "weekly limit unavailable";
				const text = expanded
					? formatQuotaText(snapshot)
					: `✓ Plan ${snapshot.plan ?? "unknown"} · ${summary}`;
				return new Text(theme.fg("success", text), 0, 0);
			},
		});
	};
}

export default createSubscriptionUsageExtension();
