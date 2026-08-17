import { describe, expect, it, vi } from "vitest";
import { createSubscriptionUsageExtension, formatAuthStatus, formatProbeResult } from "./index.ts";
import type { AnalyticsProbeResult, CodexAuthStatus } from "./types.ts";

const probeResult: Extract<AnalyticsProbeResult, { state: "ok" }> = {
	state: "ok", fetchedAt: "2026-08-17T00:00:00Z", startDate: "2026-07-19", endDate: "2026-08-17",
	endpoints: [
		{ id: "quota", path: "/quota", status: 200, state: "ok" },
		{ id: "workspace", path: "/workspace", status: 200, state: "ok", rowCount: 1 },
	],
	payloads: {
		quota: { plan_type: "plus", rate_limit: { primary_window: { used_percent: 10 } } },
		tokens: { units: "credits", data: [{ date: "2026-08-17", product_surface_usage_values: { cli: 2 }, models: [] }] },
		workspace: { data: [{ date: "2026-08-17", totals: { turns: 3, text_total_tokens: 100 }, clients: [], models: [] }] },
		skills: { data: [] }, plugins: { data: [] }, credits: { data: [] },
	},
};

const accepted: CodexAuthStatus = {
	state: "accepted", path: "/home/user/.codex/auth.json", fileFound: true,
	accessTokenPresent: true, accountIdPresent: true, credentialAccepted: true,
};

function harness(status: CodexAuthStatus = accepted, probeValue: AnalyticsProbeResult = probeResult) {
	const commands = new Map<string, any>();
	let tool: any;
	const checkAuth = vi.fn(async () => status);
	const probe = vi.fn(async (_options?: { signal?: AbortSignal; startDate?: string; endDate?: string }) => probeValue);
	createSubscriptionUsageExtension({ checkAuth, probe })({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (definition: any) => { tool = definition; },
	} as any);
	const notify = vi.fn();
	const custom = vi.fn();
	const controller = new AbortController();
	return {
		command: commands.get("usage"), tool, checkAuth, probe, notify, custom,
		ctx: { signal: controller.signal, mode: "rpc", hasUI: true, ui: { notify, custom } },
	};
}

describe("/usage and subscription_usage", () => {
	it("reports every authentication checkpoint without exposing credentials", async () => {
		const { command, checkAuth, notify, ctx } = harness();
		await command.handler("auth status", ctx);
		expect(checkAuth).toHaveBeenCalledWith({ signal: ctx.signal });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("ChatGPT credential: accepted"), "info");
		expect(formatAuthStatus(accepted)).toContain("Account ID: present");
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
	});

	it("probes every captured endpoint and reports row counts", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("probe", ctx);
		expect(probe).toHaveBeenCalledWith({ signal: ctx.signal });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("workspace: HTTP 200, 1 daily rows"), "info");
		expect(formatProbeResult(probeResult)).toContain("2026-07-19 to 2026-08-17");
	});

	it("refreshes and shows normalized analytics for the command", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("7", ctx);
		expect(probe).toHaveBeenCalledWith(expect.objectContaining({ signal: ctx.signal }));
		const range = probe.mock.calls[0]?.[0];
		expect(range).toBeDefined();
		expect((Date.parse(`${range!.endDate}T00:00:00Z`) - Date.parse(`${range!.startDate}T00:00:00Z`)) / 86_400_000).toBe(6);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Plan: plus"), "info");
	});

	it("opens the analytics component in TUI mode", async () => {
		const { command, custom, ctx } = harness();
		ctx.mode = "tui";
		custom.mockImplementation(async (factory: any, options: any) => {
			expect(options).toMatchObject({ overlay: true });
			let done = false;
			const component = factory({}, new Proxy({}, { get: () => (value: string) => value }), {}, () => { done = true; });
			component.handleInput("\r");
			expect(done).toBe(true);
		});
		await command.handler("", ctx);
		expect(custom).toHaveBeenCalledOnce();
	});

	it("returns the same normalized analytics through the tool and reuses status cache", async () => {
		const { command, tool, probe, ctx } = harness();
		await command.handler("30", ctx);
		const before = probe.mock.calls.length;
		const result = await tool.execute("call", { action: "status" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(before);
		expect(result.content[0].text).toContain("ChatGPT Codex Analytics");
		expect(result.content[0].text).toContain("Plan: plus");
		expect(result.details).toMatchObject({ startDate: "2026-07-19", dailyWorkspace: [{ date: "2026-08-17" }] });
	});

	it("validates command arguments and reports probe failures", async () => {
		const failure: AnalyticsProbeResult = { state: "contract-unknown", message: "Contract changed.", endpoints: [] };
		const failed = harness(accepted, failure);
		await failed.command.handler("30", failed.ctx);
		expect(failed.notify).toHaveBeenCalledWith(expect.stringContaining("Contract changed."), "error");

		const invalid = harness();
		await invalid.command.handler("500", invalid.ctx);
		expect(invalid.probe).not.toHaveBeenCalled();
		expect(invalid.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "error");
	});
});
