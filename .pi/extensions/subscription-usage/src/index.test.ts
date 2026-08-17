import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "./style.ts";
import {
	createSubscriptionUsageExtension,
	formatAuthStatus,
	formatOllamaAuthStatus,
	formatOllamaProbeResult,
	formatProbeResult,
} from "./index.ts";
import type { OllamaAuthInspection, UsageProbeResult, UsageSnapshot } from "./ollama-types.ts";
import type { CodexAuthInspection, QuotaProbeResult, QuotaSnapshot } from "./types.ts";

const readyInspection: CodexAuthInspection = {
	state: "ready", path: "/home/user/.codex/auth.json", fileFound: true,
	accessTokenPresent: true, accountIdPresent: true,
	credential: { accessToken: "TOP_SECRET_TOKEN", accountId: "account-123" },
};

const readyOllamaInspection: OllamaAuthInspection = {
	state: "ready",
	path: "/home/user/.ollama/id_ed25519",
	fileFound: true,
	credential: { pem: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n", path: "/home/user/.ollama/id_ed25519" },
};

const okResult: Extract<QuotaProbeResult, { state: "ok" }> = {
	state: "ok",
	fetchedAt: "2026-08-17T12:00:00.000Z",
	snapshot: {
		plan: "Pro",
		weekly: { usedPercent: 58, windowMinutes: 10_080, resetsAt: new Date(2026, 7, 24, 14, 30).toISOString() },
		resetCredits: { available: 1 },
		fetchedAt: "2026-08-17T12:00:00.000Z",
	},
};

const okOllamaResult: Extract<UsageProbeResult, { state: "ok" }> = {
	state: "ok",
	fetchedAt: "2026-08-17T12:00:00.000Z",
	snapshot: {
		session: { usedPercent: 16.2 },
		weekly: { usedPercent: 2.9 },
		weekStartsAt: "2026-07-27T00:00:00.000Z",
		fetchedAt: "2026-08-17T12:00:00.000Z",
	},
};

function harness(options: {
	probeResult?: QuotaProbeResult;
	probeOllamaResult?: UsageProbeResult;
	inspection?: CodexAuthInspection;
	inspectionOllama?: OllamaAuthInspection;
	now?: () => Date;
} = {}) {
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const probe = vi.fn(async (_options?: { signal?: AbortSignal }) => options.probeResult ?? okResult);
	const probeOllama = vi.fn(async (_options?: { signal?: AbortSignal }) => options.probeOllamaResult ?? okOllamaResult);
	const inspect = vi.fn(async () => options.inspection ?? readyInspection);
	const inspectOllama = vi.fn(async () => options.inspectionOllama ?? readyOllamaInspection);
	createSubscriptionUsageExtension({ probe, probeOllama, inspect, inspectOllama, now: options.now ?? FIXTURE_NOW })({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (definition: any) => { tools.set(definition.name, definition); },
	} as any);
	const notify = vi.fn();
	const controller = new AbortController();
	return {
		command: commands.get("usage"), tools, probe, probeOllama, inspect, inspectOllama, notify,
		ctx: { signal: controller.signal, mode: "rpc", hasUI: true, ui: { notify } },
	};
}

// The probe fixtures carry a fixed fetchedAt (12:00:00Z); pin the default
// clock to that instant so cache-freshness assertions are deterministic
// instead of depending on the wall clock.
const FIXTURE_NOW = () => new Date("2026-08-17T12:00:00.000Z");

describe("/usage (unified) and the usage tools", () => {
	it("shows both providers on a plain /usage", async () => {
		// Monday 21:20 local: 40 minutes to the full hour, 6 days to Monday —
		// the exact values observed in the web UI.
		const { command, probe, probeOllama, notify, ctx } = harness({
			now: () => new Date(2026, 7, 17, 21, 20),
		});
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probeOllama).toHaveBeenCalledTimes(1);
		const [text, level] = notify.mock.calls[0];
		expect(stripAnsi(text)).toContain("ChatGPT Codex · Plan: Pro");
		expect(stripAnsi(text)).toContain("Weekly limit: [████████████░░░░░░░░] 58% used · resets in 6d 17h on 24 Aug");
		expect(stripAnsi(text)).toContain("Ollama Cloud");
		expect(stripAnsi(text)).toContain("Session usage: [███░░░░░░░░░░░░░░░░░] 16% used · resets in 40m on 17 Aug");
		expect(stripAnsi(text)).toContain("Weekly usage: [█░░░░░░░░░░░░░░░░░░░] 3% used · resets in 6d 12h on 24 Aug");
		expect(level).toBe("info");
	});

	it("reuses both fresh caches with zero network on the second /usage", async () => {
		const { command, probe, probeOllama, ctx } = harness();
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probeOllama).toHaveBeenCalledTimes(1);
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probeOllama).toHaveBeenCalledTimes(1);
	});

	it("always fetches both for /usage refresh", async () => {
		const { command, probe, probeOllama, ctx } = harness();
		await command.handler("refresh", ctx);
		await command.handler("refresh", ctx);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(probeOllama).toHaveBeenCalledTimes(2);
	});

	it("limits to one provider with /usage codex and /usage ollama", async () => {
		const { command, probe, probeOllama, notify, ctx } = harness();
		await command.handler("codex", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probeOllama).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("ChatGPT Codex"), "info");
		expect(notify.mock.calls[0][0]).not.toContain("Ollama Cloud");

		await command.handler("ollama refresh", ctx);
		expect(probeOllama).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[1][0]).toContain("Ollama Cloud");
		expect(notify.mock.calls[1][0]).not.toContain("ChatGPT Codex");
	});

	it("refetches each provider when its cache is older than 15 minutes", async () => {
		let time = Date.parse("2026-08-17T12:00:00Z");
		const { command, probe, probeOllama, ctx } = harness({ now: () => new Date(time) });
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probeOllama).toHaveBeenCalledTimes(1);
		time = Date.parse("2026-08-17T12:20:00Z");
		await command.handler("", ctx);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(probeOllama).toHaveBeenCalledTimes(2);
	});

	it("reports auth status for both providers from files only, without any network", async () => {
		const { command, probe, probeOllama, notify, ctx } = harness();
		await command.handler("auth status", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(probeOllama).not.toHaveBeenCalled();
		const [text, level] = notify.mock.calls[0];
		expect(text).toContain("ChatGPT Codex authentication");
		expect(text).toContain("Ollama Cloud authentication");
		expect(text).toContain("Credential looks usable; /usage validates it live.");
		expect(text).toContain("Ed25519 key parses and can sign; /usage validates it live.");
		expect(level).toBe("info");
		expect(formatAuthStatus(readyInspection)).toContain("Account ID: present");
		expect(formatOllamaAuthStatus(readyOllamaInspection)).toContain("Key file: found");
	});

	it("reports a single provider's auth failures as warnings", async () => {
		const inspection: CodexAuthInspection = {
			state: "missing", path: "/missing/auth.json", fileFound: false,
			accessTokenPresent: false, accountIdPresent: false,
			message: "Codex auth file was not found. Run `codex login` and try again.",
		};
		const { command, probe, notify, ctx } = harness({ inspection });
		await command.handler("codex auth", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run `codex login`"), "warning");
	});

	it("runs the single-endpoint probes for both providers", async () => {
		const { command, probe, probeOllama, notify, ctx } = harness();
		await command.handler("probe", ctx);
		expect(probe).toHaveBeenCalledWith({ signal: ctx.signal });
		expect(probeOllama).toHaveBeenCalledWith({ signal: ctx.signal });
		const [text] = notify.mock.calls[0];
		expect(text).toContain("Codex quota probe: connected · plan Pro");
		expect(text).toContain("Ollama usage probe: connected");
		expect(formatProbeResult(okResult)).toContain("connected");
		expect(formatOllamaProbeResult(okOllamaResult)).toContain("connected");
	});

	it("shows the healthy provider and an inline error when the other fails", async () => {
		const { command, probe, probeOllama, notify, ctx } = harness({
			probeOllamaResult: {
				state: "auth-required",
				message: "The Ollama key was not found. Sign in to the Ollama app to create ~/.ollama/id_ed25519.",
			},
		});
		await command.handler("", ctx);
		const [text, level] = notify.mock.calls[0];
		expect(text).toContain("ChatGPT Codex · Plan: Pro");
		expect(text).toContain("Ollama Cloud: The Ollama key was not found.");
		expect(level).toBe("info");
	});

	it("notifies an error when both providers fail", async () => {
		const { command, probe, probeOllama, notify, ctx } = harness({
			probeResult: { state: "unavailable", message: "Could not reach the ChatGPT usage endpoint." },
			probeOllamaResult: { state: "unavailable", message: "Could not reach the Ollama usage endpoint." },
		});
		await command.handler("", ctx);
		const [text, level] = notify.mock.calls[0];
		expect(text).toContain("ChatGPT Codex: Could not reach");
		expect(text).toContain("Ollama Cloud: Could not reach");
		expect(level).toBe("error");
	});

	it("rejects unknown arguments without fetching", async () => {
		const { command, probe, probeOllama, notify, ctx } = harness();
		await command.handler("7", ctx);
		expect(probe).not.toHaveBeenCalled();
		expect(probeOllama).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /usage"), "error");
	});

	it("returns quota through subscription_usage and reuses the fresh cache", async () => {
		const { command, tools, probe, ctx } = harness();
		const tool = tools.get("subscription_usage");
		await command.handler("", ctx);
		const before = probe.mock.calls.length;
		const result = await tool.execute("call", { action: "status" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(before);
		expect(result.content[0].text).toContain("ChatGPT Codex · Plan: Pro");
		expect(result.content[0].text).toContain("Rate-limit reset credits: 1 available");
		expect(result.details).toMatchObject({ plan: "Pro", weekly: { usedPercent: 58 } });
	});

	it("returns usage through ollama_usage and reuses the fresh cache", async () => {
		const { command, tools, probeOllama, ctx } = harness();
		const tool = tools.get("ollama_usage");
		await command.handler("", ctx);
		const before = probeOllama.mock.calls.length;
		const result = await tool.execute("call", { action: "status" }, ctx.signal);
		expect(probeOllama).toHaveBeenCalledTimes(before);
		expect(result.content[0].text).toContain("Ollama Cloud");
		expect(result.content[0].text).toContain("Weekly usage: [█░░░░░░░░░░░░░░░░░░░] 3% used");
		expect(result.details).toMatchObject({ session: { usedPercent: 16.2 } });
	});

	it("fetches for tool refresh even when the cache is fresh", async () => {
		const { command, tools, probe, probeOllama, ctx } = harness();
		await command.handler("", ctx);
		await tools.get("subscription_usage").execute("call", { action: "refresh" }, ctx.signal);
		expect(probe).toHaveBeenCalledTimes(2);
		await tools.get("ollama_usage").execute("call", { action: "refresh" }, ctx.signal);
		expect(probeOllama).toHaveBeenCalledTimes(2);
	});

	it("surfaces probe failures clearly in the tools", async () => {
		const rejected = harness({
			probeResult: {
				state: "auth-required",
				message: "ChatGPT rejected the Codex credential (HTTP 401). Run `codex login` and try again.",
			},
		});
		await expect(
			rejected.tools.get("subscription_usage").execute("call", { action: "refresh" }, rejected.ctx.signal),
		).rejects.toThrow("codex login");
	});
});
