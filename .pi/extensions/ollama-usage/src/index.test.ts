import { describe, expect, it, vi } from "vitest";
import { createOllamaUsageExtension, formatAuthStatus, formatProbeResult } from "./index.ts";
import type { OllamaAuthInspection, UsageProbeResult, UsageSnapshot } from "./types.ts";

const readyInspection: OllamaAuthInspection = {
	state: "ready",
	path: "/home/user/.ollama/id_ed25519",
	fileFound: true,
	credential: { pem: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n", path: "/home/user/.ollama/id_ed25519" },
};

const okResult: Extract<UsageProbeResult, { state: "ok" }> = {
	state: "ok",
	fetchedAt: "2026-08-17T12:00:00.000Z",
	snapshot: {
		plan: "pro",
		session: { usedPercent: 5, resetsIn: "5 hours" },
		weekly: { usedPercent: 50, resetsIn: "4 days" },
		fetchedAt: "2026-08-17T12:00:00.000Z",
	},
};

function harness(options: {
	probeResult?: UsageProbeResult;
	inspection?: OllamaAuthInspection;
	now?: () => Date;
} = {}) {
	const commands = new Map<string, any>();
	let tool: any;
	const probe = vi.fn(async (_options?: { signal?: AbortSignal }) => options.probeResult ?? okResult);
	const inspect = vi.fn(async () => options.inspection ?? readyInspection);
	createOllamaUsageExtension({ probe, inspect, now: options.now })({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (definition: any) => { tool = definition; },
	} as any);
	const notify = vi.fn();
	const controller = new AbortController();
	return {
		command: commands.get("ollama-usage"), tool, probe, inspect, notify,
		ctx: { signal: controller.signal, mode: "rpc", hasUI: true, ui: { notify } },
	};
}

describe("/ollama-usage and ollama_usage", () => {
	it("reports auth status from the key file only, without any network", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("auth status", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Ed25519 key parses and can sign; /ollama-usage validates it live."), "info");
		expect(formatAuthStatus(readyInspection)).toContain("Key file: found");
	});

	it("reports actionable auth failures as warnings without any network", async () => {
		const inspection: OllamaAuthInspection = {
			state: "missing",
			path: "/missing/id_ed25519",
			fileFound: false,
			message: "The Ollama key was not found. Sign in to the Ollama app to create ~/.ollama/id_ed25519.",
		};
		const { command, probe, notify, ctx } = harness({ inspection });
		await command.handler("auth", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Sign in to the Ollama app"), "warning");
	});

	it("fetches on the first /ollama-usage and reuses the fresh cache with zero network", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Session usage: 5% used · resets in 5 hours"), "info");
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

	it("always fetches for /ollama-usage refresh", async () => {
		const { command, probe, ctx } = harness();
		await command.handler("refresh", ctx);
		await command.handler("refresh", ctx);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("runs the single-endpoint probe command", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("probe", ctx);
		expect(probe).toHaveBeenCalledWith({ signal: ctx.signal });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Ollama usage probe: connected · plan pro"), "info");
		expect(formatProbeResult(okResult)).toContain("connected");
	});

	it("rejects unknown arguments without fetching", async () => {
		const { command, probe, notify, ctx } = harness();
		await command.handler("7", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /ollama-usage"), "error");
	});

	it("returns usage through the tool and reuses the fresh cache", async () => {
		const { command, tool, probe, ctx } = harness();
		await command.handler("", ctx);
		const before = probe.mock.calls.length;
		const result = await tool.execute("call", { action: "status" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(before);
		expect(result.content[0].text).toContain("Ollama Cloud · Plan: pro");
		expect(result.content[0].text).toContain("Weekly usage: 50% used · resets in 4 days");
		expect(result.details).toMatchObject({ plan: "pro", weekly: { usedPercent: 50 } });
	});

	it("fetches for tool status without a cache and always for refresh", async () => {
		const { tool, probe, ctx } = harness();
		const first = await tool.execute("call", { action: "status" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(first.content[0].text).toContain("Plan: pro");
		await tool.execute("call", { action: "refresh" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("surfaces probe failures clearly in the command and tool", async () => {
		const unavailable = harness({
			probeResult: { state: "unavailable", message: "Could not reach the Ollama usage endpoint." },
		});
		await unavailable.command.handler("", unavailable.ctx);
		expect(unavailable.notify).toHaveBeenCalledWith("Could not reach the Ollama usage endpoint.", "error");

		const rejected = harness({
			probeResult: {
				state: "auth-required",
				message: "the Ollama key is not linked to an account — open https://ollama.com/connect",
			},
		});
		await expect(
			rejected.tool.execute("call", { action: "refresh" }, rejected.ctx.signal),
		).rejects.toThrow("https://ollama.com/connect");
	});

	it("marks stale snapshots in rendered output", async () => {
		const stale: UsageSnapshot = {
			plan: "pro",
			session: { usedPercent: 5 },
			weekly: { usedPercent: 50 },
			fetchedAt: "2026-08-17T12:00:00.000Z",
		};
		const { command, notify, ctx } = harness({
			probeResult: { state: "ok", fetchedAt: stale.fetchedAt, snapshot: stale },
			now: () => new Date("2026-08-17T13:00:00.000Z"),
		});
		await command.handler("", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("(stale)"), "info");
	});
});
