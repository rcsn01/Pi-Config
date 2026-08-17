import { describe, expect, it, vi } from "vitest";
import { createSubscriptionUsageExtension, formatAuthStatus, formatProbeResult } from "./index.ts";
import type { AnalyticsProbeResult, CodexAuthStatus } from "./types.ts";

const probeResult: AnalyticsProbeResult = {
	state: "ok", fetchedAt: "2026-08-17T00:00:00Z", startDate: "2026-07-19", endDate: "2026-08-17",
	endpoints: [
		{ id: "quota", path: "/quota", status: 200, state: "ok" },
		{ id: "tokens", path: "/tokens", status: 200, state: "ok", rowCount: 30 },
	],
	payloads: { quota: {}, tokens: {}, workspace: {}, skills: {}, plugins: {}, credits: {} },
};

function harness(status: CodexAuthStatus, probeValue: AnalyticsProbeResult = probeResult) {
	const commands = new Map<string, any>();
	const checkAuth = vi.fn(async () => status);
	const probe = vi.fn(async () => probeValue);
	createSubscriptionUsageExtension({ checkAuth, probe })(
		{ registerCommand: (name: string, command: any) => commands.set(name, command) } as any,
	);
	const notify = vi.fn();
	const controller = new AbortController();
	return {
		command: commands.get("usage"), checkAuth, probe, notify,
		ctx: { signal: controller.signal, ui: { notify } },
	};
}

const accepted: CodexAuthStatus = {
	state: "accepted", path: "/home/user/.codex/auth.json", fileFound: true,
	accessTokenPresent: true, accountIdPresent: true, credentialAccepted: true,
};

describe("/usage authentication and endpoint probe", () => {
	it("reports every authentication checkpoint without exposing credentials", async () => {
		const { command, checkAuth, notify, ctx } = harness(accepted);
		await command.handler("auth status", ctx);
		expect(checkAuth).toHaveBeenCalledWith({ signal: ctx.signal });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("ChatGPT credential: accepted"), "info");
		const output = notify.mock.calls[0][0];
		expect(output).toContain("Auth file: found");
		expect(output).toContain("Access token: present");
		expect(output).toContain("Account ID: present");
	});

	it("reports actionable authentication failures as warnings", async () => {
		const status: CodexAuthStatus = {
			state: "missing", path: "/missing/auth.json", fileFound: false,
			accessTokenPresent: false, accountIdPresent: false, credentialAccepted: false,
			message: "Run `codex login` and try again.",
		};
		const { command, notify, ctx } = harness(status);
		await command.handler("auth", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run `codex login`"), "warning");
		expect(formatAuthStatus(status)).toContain("ChatGPT credential: not accepted");
	});

	it("probes every captured endpoint and reports row counts", async () => {
		const { command, probe, notify, ctx } = harness(accepted);
		await command.handler("probe", ctx);
		expect(probe).toHaveBeenCalledWith({ signal: ctx.signal });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("tokens: HTTP 200, 30 daily rows"), "info");
		expect(formatProbeResult(probeResult)).toContain("2026-07-19 to 2026-08-17");
	});

	it("reports probe failures without attempting an unrelated action", async () => {
		const failure: AnalyticsProbeResult = {
			state: "contract-unknown", message: "Contract changed.",
			endpoints: [{ id: "quota", path: "/quota", status: 200, state: "contract-unknown" }],
		};
		const { command, checkAuth, notify, ctx } = harness(accepted, failure);
		await command.handler("probe", ctx);
		expect(checkAuth).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Contract changed."), "warning");
	});

	it("directs the default command to the captured endpoint probe", async () => {
		const { command, checkAuth, probe, notify, ctx } = harness(accepted);
		await command.handler("", ctx);
		expect(checkAuth).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/usage probe"), "info");
	});
});
