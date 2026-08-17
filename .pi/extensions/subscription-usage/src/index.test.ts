import { describe, expect, it, vi } from "vitest";
import { createSubscriptionUsageExtension, formatAuthStatus, formatProbeResult } from "./index.ts";
import type { CodexAuthInspection, QuotaProbeResult, QuotaSnapshot } from "./types.ts";

const readyInspection: CodexAuthInspection = {
	state: "ready", path: "/home/user/.codex/auth.json", fileFound: true,
	accessTokenPresent: true, accountIdPresent: true,
	credential: { accessToken: "TOP_SECRET_TOKEN", accountId: "account-123" },
};

const okResult: Extract<QuotaProbeResult, { state: "ok" }> = {
	state: "ok",
	fetchedAt: "2026-08-17T12:00:00.000Z",
	snapshot: {
		plan: "Pro",
		weekly: { usedPercent: 58, windowMinutes: 10_080, resetsAt: "2026-08-24T14:30:00.000Z" },
		resetCredits: { available: 1 },
		fetchedAt: "2026-08-17T12:00:00.000Z",
	},
};

function harness(options: {
	probeResult?: QuotaProbeResult;
	inspection?: CodexAuthInspection;
	now?: () => Date;
} = {}) {
	const commands = new Map<string, any>();
	let tool: any;
	const probe = vi.fn(async (_options?: { signal?: AbortSignal }) => options.probeResult ?? okResult);
	const inspect = vi.fn(async () => options.inspection ?? readyInspection);
	createSubscriptionUsageExtension({ probe, inspect, now: options.now })({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (definition: any) => { tool = definition; },
	} as any);
	const notify = vi.fn();
	const controller = new AbortController();
	return {
		command: commands.get("usage"), tool, probe, inspect, notify,
		ctx: { signal: controller.signal, mode: "rpc", hasUI: true, ui: { notify } },
	};
}

describe("/usage and subscription_usage", () => {
	it("reports auth status from the file only, without any network", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("auth status", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Credential looks usable; /usage validates it live."), "info");
		expect(formatAuthStatus(readyInspection)).toContain("Account ID: present");
	});

	it("reports actionable auth failures as warnings without any network", async () => {
		const inspection: CodexAuthInspection = {
			state: "missing", path: "/missing/auth.json", fileFound: false,
			accessTokenPresent: false, accountIdPresent: false,
			message: "Codex auth file was not found. Run `codex login` and try again.",
		};
		const { command, probe, notify, ctx } = harness({ inspection });
		await command.handler("auth", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run `codex login`"), "warning");
	});

	it("fetches on the first /usage and reuses the fresh cache with zero network", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Weekly limit: 58% used"), "info");
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("refetches when the cached snapshot is older than 15 minutes", async () => {
		let time = Date.parse("2026-08-17T12:00:00Z");
		const { command, probe, ctx } = harness({ now: () => new Date(time) });
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
		time = Date.parse("2026-08-17T12:20:00Z");
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("always fetches for /usage refresh", async () => {
		const { command, probe, ctx } = harness();
		await command.handler("refresh", ctx);
		await command.handler("refresh", ctx);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("runs the single-endpoint probe command", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("probe", ctx);
		expect(probe).toHaveBeenCalledWith({ signal: ctx.signal });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Codex quota probe: connected · plan Pro"), "info");
		expect(formatProbeResult(okResult)).toContain("connected");
	});

	it("rejects unknown arguments without fetching", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("7", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /usage"), "error");
	});

	it("returns quota through the tool and reuses the fresh cache", async () => {
		const { command, tool, probe, ctx } = harness();
		await command.handler("", ctx);
		const before = probe.mock.calls.length;
		const result = await tool.execute("call", { action: "status" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(before);
		expect(result.content[0].text).toContain("ChatGPT Codex · Plan: Pro");
		expect(result.content[0].text).toContain("Rate-limit reset credits: 1 available");
		expect(result.details).toMatchObject({ plan: "Pro", weekly: { usedPercent: 58 } });
	});

	it("fetches for tool status without a cache and always for refresh", async () => {
		const { tool, probe, ctx } = harness();
		const first = await tool.execute("call", { action: "status" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(first.content[0].text).toContain("Plan: Pro");
		await tool.execute("call", { action: "refresh" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("surfaces probe failures clearly in the command and tool", async () => {
		const unavailable = harness({
			probeResult: { state: "unavailable", message: "Could not reach the ChatGPT usage endpoint." },
		});
		await unavailable.command.handler("", unavailable.ctx);
		expect(unavailable.notify).toHaveBeenCalledWith("Could not reach the ChatGPT usage endpoint.", "error");

		const rejected = harness({
			probeResult: {
				state: "auth-required",
				message: "ChatGPT rejected the Codex credential (HTTP 401). Run `codex login` and try again.",
			},
		});
		await expect(
			rejected.tool.execute("call", { action: "refresh" }, rejected.ctx.signal),
		).rejects.toThrow("codex login");
	});
});
