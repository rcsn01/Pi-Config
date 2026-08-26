import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "./style.ts";
import {
	createSubscriptionUsageExtension,
	formatCodexAuthStatus,
	formatOllamaAuthStatus,
	formatOllamaProbeResult,
	formatProbeResult,
} from "./index.ts";
import type { CodexCredentialSlotInspection } from "../../provider-codex/credential-slots.ts";
import type { CodexSlotQuotaBatch, CodexSlotUsageClientLike } from "./codex-slots.ts";
import { isStale } from "./probe.ts";
import type { OllamaAuthInspection, UsageProbeResult } from "./ollama-types.ts";
import type { QuotaProbeResult } from "./types.ts";

const readyCodexInspection: CodexCredentialSlotInspection = {
	revision: "revision-without-secrets",
	activeSlotId: "default",
	activeSlotName: "default",
	slots: [{ id: "default", name: "default", active: true, hasCredential: true, status: "active" }],
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
		session: { usedPercent: 16, windowMinutes: 300 },
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

function codexBatch(result: QuotaProbeResult = okResult): CodexSlotQuotaBatch {
	return {
		slots: [{ slot: readyCodexInspection.slots[0]!, result }],
		anySuccess: result.state === "ok",
	};
}

function harness(options: {
	codexBatch?: CodexSlotQuotaBatch;
	probeOllamaResult?: UsageProbeResult;
	inspection?: CodexCredentialSlotInspection;
	inspectionOllama?: OllamaAuthInspection;
	now?: () => Date;
} = {}) {
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const clock = options.now ?? FIXTURE_NOW;
	const codexNetwork = vi.fn(async (_options?: { cache?: string; signal?: AbortSignal }) => options.codexBatch ?? codexBatch());
	let cachedCodex: CodexSlotQuotaBatch | undefined;
	const codexQuery = vi.fn(async (queryOptions: { cache?: string; signal?: AbortSignal } = {}) => {
		queryOptions.signal?.throwIfAborted();
		const cachedSnapshot = cachedCodex?.slots.find((entry) => entry.result.state === "ok");
		if (queryOptions.cache === "prefer" && cachedCodex && cachedSnapshot?.result.state === "ok" && !isStale(cachedSnapshot.result.fetchedAt, clock())) {
			return cachedCodex;
		}
		const result = await codexNetwork(queryOptions);
		if (queryOptions.cache !== "bypass") cachedCodex = result;
		return result;
	});
	const codex: CodexSlotUsageClientLike = {
		inspect: vi.fn(() => options.inspection ?? readyCodexInspection),
		query: codexQuery,
	};
	const probeOllama = vi.fn(async (_options?: { signal?: AbortSignal }) => options.probeOllamaResult ?? okOllamaResult);
	const inspectOllama = vi.fn(async () => options.inspectionOllama ?? readyOllamaInspection);
	createSubscriptionUsageExtension({ codex, probeOllama, inspectOllama, now: options.now ?? FIXTURE_NOW })({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (definition: any) => { tools.set(definition.name, definition); },
	} as any);
	const notify = vi.fn();
	const controller = new AbortController();
	return {
		command: commands.get("usage"),
		tools,
		codex,
		codexQuery,
		codexNetwork,
		probeOllama,
		inspectOllama,
		notify,
		ctx: { signal: controller.signal, mode: "rpc", hasUI: true, ui: { notify } },
	};
}

// The probe fixtures carry a fixed fetchedAt (12:00:00Z); pin the default
// clock to that instant so cache-freshness assertions are deterministic.
const FIXTURE_NOW = () => new Date("2026-08-17T12:00:00.000Z");

describe("/usage (unified)", () => {
	it("shows both providers on a plain /usage", async () => {
		const { command, codexNetwork, probeOllama, notify, ctx } = harness({
			now: () => new Date(2026, 7, 17, 21, 20),
		});
		await command.handler("", ctx);
		expect(codexNetwork).toHaveBeenCalledTimes(1);
		expect(probeOllama).toHaveBeenCalledTimes(1);
		const [text, level] = notify.mock.calls[0];
		expect(stripAnsi(text)).toContain("ChatGPT Codex · Slot: default (active) · Plan: Pro");
		expect(stripAnsi(text)).toContain("5-hour session limit: [███░░░░░░░░░░░░░░░░░] 16% used");
		expect(stripAnsi(text)).toContain("Weekly limit: [████████████░░░░░░░░] 58% used · resets in 6d 17h on 24 Aug");
		expect(stripAnsi(text)).toContain("Ollama Cloud");
		expect(stripAnsi(text)).toContain("Session usage: [███░░░░░░░░░░░░░░░░░] 16% used · resets in 40m on 17 Aug");
		expect(stripAnsi(text)).toContain("Weekly usage: [█░░░░░░░░░░░░░░░░░░░] 3% used · resets in 6d 12h on 24 Aug");
		expect(level).toBe("info");
	});

	it("reuses both fresh caches with zero network on the second /usage", async () => {
		const { command, codexNetwork, probeOllama, ctx } = harness();
		await command.handler("", ctx);
		expect(codexNetwork).toHaveBeenCalledTimes(1);
		expect(probeOllama).toHaveBeenCalledTimes(1);
		await command.handler("", ctx);
		expect(codexNetwork).toHaveBeenCalledTimes(1);
		expect(probeOllama).toHaveBeenCalledTimes(1);
	});

	it("always fetches both for /usage refresh", async () => {
		const { command, codexNetwork, probeOllama, ctx } = harness();
		await command.handler("refresh", ctx);
		await command.handler("refresh", ctx);
		expect(codexNetwork).toHaveBeenCalledTimes(2);
		expect(probeOllama).toHaveBeenCalledTimes(2);
	});

	it("limits to one provider with /usage codex and /usage ollama", async () => {
		const { command, codexNetwork, probeOllama, notify, ctx } = harness();
		await command.handler("codex", ctx);
		expect(codexNetwork).toHaveBeenCalledTimes(1);
		expect(probeOllama).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("ChatGPT Codex"), "info");
		expect(notify.mock.calls[0][0]).not.toContain("Ollama Cloud");

		await command.handler("ollama refresh", ctx);
		expect(probeOllama).toHaveBeenCalledTimes(1);
		expect(codexNetwork).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[1][0]).toContain("Ollama Cloud");
		expect(notify.mock.calls[1][0]).not.toContain("ChatGPT Codex");
	});

	it("refetches each provider when its cache is older than 15 minutes", async () => {
		let time = Date.parse("2026-08-17T12:00:00Z");
		const { command, codexNetwork, probeOllama, ctx } = harness({ now: () => new Date(time) });
		await command.handler("", ctx);
		expect(codexNetwork).toHaveBeenCalledTimes(1);
		expect(probeOllama).toHaveBeenCalledTimes(1);
		time = Date.parse("2026-08-17T12:20:00Z");
		await command.handler("", ctx);
		expect(codexNetwork).toHaveBeenCalledTimes(2);
		expect(probeOllama).toHaveBeenCalledTimes(2);
	});

	it("reports all Pi Codex slots and Ollama auth status without any network", async () => {
		const { command, codexNetwork, probeOllama, notify, ctx } = harness();
		await command.handler("auth status", ctx);
		expect(codexNetwork).not.toHaveBeenCalled();
		expect(probeOllama).not.toHaveBeenCalled();
		const [text, level] = notify.mock.calls[0];
		expect(text).toContain("Pi Codex credential slots");
		expect(text).toContain("default (active)");
		expect(text).toContain("Ollama Cloud authentication");
		expect(text).toContain("Ed25519 key parses and can sign; /usage validates it live.");
		expect(level).toBe("info");
		expect(formatCodexAuthStatus(readyCodexInspection)).toContain("Active slot: default");
		expect(formatOllamaAuthStatus(readyOllamaInspection)).toContain("Key file: found");
	});

	it("marks an all-empty Codex slot list as a warning without probing", async () => {
		const emptyInspection: CodexCredentialSlotInspection = {
			...readyCodexInspection,
			slots: [{ ...readyCodexInspection.slots[0]!, hasCredential: false, status: "active" }],
		};
		const { command, notify, ctx } = harness({ inspection: emptyInspection });
		await command.handler("codex auth status", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("active, empty"), "warning");
	});

	it("runs all-slot Codex probes alongside the Ollama probe", async () => {
		const { command, codexNetwork, probeOllama, notify, ctx } = harness();
		await command.handler("probe", ctx);
		expect(codexNetwork).toHaveBeenCalledWith({ cache: "bypass", signal: ctx.signal });
		expect(probeOllama).toHaveBeenCalledWith({ signal: ctx.signal });
		const [text] = notify.mock.calls[0];
		expect(text).toContain("ChatGPT Codex · Slot: default (active) · Plan: Pro");
		expect(text).toContain("Ollama usage probe: connected");
		expect(formatProbeResult(okResult)).toContain("connected");
		expect(formatOllamaProbeResult(okOllamaResult)).toContain("connected");
	});

	it("shows the healthy provider and inline per-slot errors when the other fails", async () => {
		const { command, codexNetwork, probeOllama, notify, ctx } = harness({
			codexBatch: codexBatch({ state: "auth-required", message: "This Codex slot is empty." }),
		});
		await command.handler("", ctx);
		const [text, level] = notify.mock.calls[0];
		expect(text).toContain("ChatGPT Codex · Slot: default (active)");
		expect(text).toContain("This Codex slot is empty.");
		expect(text).toContain("Ollama Cloud");
		expect(level).toBe("info");
		expect(codexNetwork).toHaveBeenCalledOnce();
		expect(probeOllama).toHaveBeenCalledOnce();
	});

	it("notifies an error when every requested provider/account fails", async () => {
		const { command, notify, ctx } = harness({
			codexBatch: codexBatch({ state: "unavailable", message: "Could not reach the ChatGPT usage endpoint." }),
			probeOllamaResult: { state: "unavailable", message: "Could not reach the Ollama usage endpoint." },
		});
		await command.handler("", ctx);
		const [text, level] = notify.mock.calls[0];
		expect(text).toContain("ChatGPT Codex · Slot: default (active)");
		expect(text).toContain("Could not reach the ChatGPT usage endpoint.");
		expect(text).toContain("Ollama Cloud: Could not reach");
		expect(level).toBe("error");
	});

	it("rejects unknown arguments without fetching", async () => {
		const { command, codexNetwork, probeOllama, notify, ctx } = harness();
		await command.handler("7", ctx);
		expect(codexNetwork).not.toHaveBeenCalled();
		expect(probeOllama).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /usage"), "error");
	});

	it("does not expose subscription usage as an LLM tool", () => {
		const { tools } = harness();
		expect(tools.size).toBe(0);
	});
});
