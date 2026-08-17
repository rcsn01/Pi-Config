import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkCodexAuthentication } from "./auth-check.ts";
import type { CodexAuthStatus } from "./types.ts";

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

export function createSubscriptionUsageExtension(options: {
	checkAuth?: typeof checkCodexAuthentication;
} = {}) {
	return function subscriptionUsageExtension(pi: ExtensionAPI): void {
		const checkAuth = options.checkAuth ?? checkCodexAuthentication;
		pi.registerCommand("usage", {
			description: "Show ChatGPT Codex analytics usage or validate Codex authentication",
			handler: async (rawArgs, ctx) => {
				const action = rawArgs.trim().toLowerCase();
				if (action !== "auth" && action !== "auth status") {
					ctx.ui.notify("Analytics endpoint discovery is pending. Run `/usage auth status` first.", "info");
					return;
				}
				const status = await checkAuth({ signal: ctx.signal });
				ctx.ui.notify(formatAuthStatus(status), status.state === "accepted" ? "info" : "warning");
			},
		});
	};
}

export default createSubscriptionUsageExtension();
