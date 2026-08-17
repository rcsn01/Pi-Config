import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probeCodexAnalytics } from "./analytics-client.ts";
import { checkCodexAuthentication } from "./auth-check.ts";
import type { AnalyticsProbeResult, CodexAuthStatus } from "./types.ts";

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

export function createSubscriptionUsageExtension(options: {
	checkAuth?: typeof checkCodexAuthentication;
	probe?: typeof probeCodexAnalytics;
} = {}) {
	return function subscriptionUsageExtension(pi: ExtensionAPI): void {
		const checkAuth = options.checkAuth ?? checkCodexAuthentication;
		const probe = options.probe ?? probeCodexAnalytics;
		pi.registerCommand("usage", {
			description: "Show ChatGPT Codex analytics usage or validate Codex authentication",
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
				ctx.ui.notify("Run `/usage probe` to check the captured ChatGPT analytics endpoints.", "info");
			},
		});
	};
}

export default createSubscriptionUsageExtension();
