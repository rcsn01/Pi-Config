import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { inspectOllamaAuth } from "./ollama-auth.ts";
import { formatUsageText } from "./render.ts";
import { isUsageStale } from "./usage.ts";
import { probeUsage } from "./usage-client.ts";
import type { OllamaAuthInspection, UsageProbeResult, UsageSnapshot } from "./types.ts";

const UsageToolParams = Type.Object({
	action: StringEnum(["status", "refresh"] as const, {
		description: "Read the latest in-memory usage snapshot or query ollama.com first",
	}),
});

export function formatAuthStatus(status: OllamaAuthInspection): string {
	const lines = [
		"Ollama Cloud authentication",
		`Key file: ${status.fileFound ? `found (${status.path})` : `not found (${status.path})`}`,
	];
	if (status.state === "ready") {
		lines.push("Ed25519 key parses and can sign; /ollama-usage validates it live.");
	} else {
		lines.push(`Next step: ${status.message}`);
	}
	return lines.join("\n");
}

export function formatProbeResult(result: UsageProbeResult): string {
	if (result.state === "ok") {
		return `Ollama usage probe: connected · plan ${result.snapshot.plan ?? "unknown"}`;
	}
	return `Ollama usage probe: ${result.state}\n${result.message}`;
}

export function createOllamaUsageExtension(options: {
	probe?: typeof probeUsage;
	inspect?: typeof inspectOllamaAuth;
	now?: () => Date;
} = {}) {
	return function ollamaUsageExtension(pi: ExtensionAPI): void {
		const probe = options.probe ?? probeUsage;
		const inspect = options.inspect ?? inspectOllamaAuth;
		const now = options.now ?? (() => new Date());
		let latest: UsageSnapshot | undefined;

		const fresh = (): UsageSnapshot | undefined =>
			latest && !isUsageStale(latest.fetchedAt, now()) ? latest : undefined;

		const refresh = async (signal?: AbortSignal): Promise<UsageSnapshot> => {
			const result = await probe({ signal });
			if (result.state !== "ok") throw new Error(result.message);
			latest = result.snapshot;
			return latest;
		};

		pi.registerCommand("ollama-usage", {
			description: "Show the Ollama Cloud session and weekly usage",
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
					ctx.ui.notify("Usage: /ollama-usage [refresh] | /ollama-usage probe | /ollama-usage auth status", "error");
					return;
				}
				try {
					const snapshot = action === "refresh" ? undefined : fresh();
					ctx.ui.notify(formatUsageText(snapshot ?? await refresh(ctx.signal), now()), "info");
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				}
			},
		});

		pi.registerTool({
			name: "ollama_usage",
			label: "Ollama Cloud Usage",
			description: "Read the Ollama Cloud session and weekly usage from the authenticated Ollama key. Status uses the latest in-memory snapshot when available; refresh queries ollama.com.",
			parameters: UsageToolParams,
			async execute(_toolCallId, params, signal) {
				const snapshot = params.action === "status"
					? fresh() ?? await refresh(signal)
					: await refresh(signal);
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
			renderResult(result, { expanded }, theme) {
				const snapshot = result.details as UsageSnapshot | undefined;
				if (!snapshot) {
					const content = result.content[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
				const summary = snapshot.weekly
					? `${Math.round(snapshot.weekly.usedPercent)}% of weekly usage used`
					: "weekly usage unavailable";
				const text = expanded ? formatUsageText(snapshot) : `✓ ${summary}`;
				return new Text(theme.fg("success", text), 0, 0);
			},
		});
	};
}

export default createOllamaUsageExtension();
