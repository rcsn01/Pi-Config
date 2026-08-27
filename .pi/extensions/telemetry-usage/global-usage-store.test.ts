import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
	buildGlobalUsageSnapshot,
	classifySessionEntries,
	type GlobalMode,
	type GlobalSessionRecord,
	type SessionUsageEntry,
} from "../_shared/global-usage.ts";
import { scanGlobalUsage } from "./global-usage-store.ts";

const TS = "2026-01-01T00:00:00.000Z";
const USAGE = { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: { total: 0.25 } };

function asEntries(items: unknown[]): FileEntry[] {
	return items as FileEntry[];
}

function planState(id: string, parentId: string | null, data: Record<string, unknown>): unknown {
	return { type: "custom", id, parentId, timestamp: TS, customType: "plan-mode-state", data };
}

function assistant(
	id: string,
	parentId: string | null,
	model = "claude-x",
	provider = "anthropic",
	usage: unknown = USAGE,
	stopReason: "stop" | "error" = "stop",
): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: { role: "assistant", provider, model, usage, stopReason },
	};
}

function toolResult(id: string, parentId: string | null, toolName: string, overrides: Record<string, unknown> = {}): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: { role: "toolResult", toolName, ...overrides },
	};
}

function usageEntry(
	id: string,
	mode: GlobalMode,
	model: string,
	input: number,
	cost = 0,
	turns = 1,
): SessionUsageEntry {
	return { id, mode, model, input, output: 0, cacheRead: 0, cacheWrite: 0, cost, turns };
}

function record(file: string, id: string, created: string, entries: SessionUsageEntry[]): GlobalSessionRecord {
	return { file, id, cwd: "/repo", created, firstMessage: "", messageCount: entries.length, entries };
}

describe("classifySessionEntries", () => {
	it("classifies assistant turns as main with provider/model attribution and one turn each", () => {
		const result = classifySessionEntries(asEntries([
			assistant("a1", null, "claude-x"),
			assistant("a2", "a1", "gpt-5", "openai"),
		]));
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ id: "a1", mode: "main", model: "anthropic/claude-x", timestamp: Date.parse(TS), turns: 1, input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: 0.25 });
		expect(result[1]).toMatchObject({ id: "a2", mode: "main", model: "openai/gpt-5" });
	});

	it("splits plan mode turns using the new {mode} plan-state shape", () => {
		const result = classifySessionEntries(asEntries([
			planState("p1", null, { mode: "plan", revision: 1 }),
			assistant("a1", "p1"),
			planState("p2", "a1", { mode: "default", revision: 2 }),
			assistant("a2", "p2"),
		]));
		expect(result.map((entry) => [entry.id, entry.mode])).toEqual([["a1", "plan"], ["a2", "main"]]);
	});

	it("splits plan mode turns using the legacy {active} plan-state shape", () => {
		const result = classifySessionEntries(asEntries([
			planState("p1", null, { active: true }),
			assistant("a1", "p1"),
			planState("p2", "a1", { active: false }),
			assistant("a2", "p2"),
		]));
		expect(result.map((entry) => [entry.id, entry.mode])).toEqual([["a1", "plan"], ["a2", "main"]]);
	});

	it("tracks plan mode per branch via the parentId chain", () => {
		const result = classifySessionEntries(asEntries([
			{ type: "message", id: "u1", parentId: null, timestamp: TS, message: { role: "user", content: "hi" } },
			planState("p1", "u1", { active: true }),
			assistant("a1", "p1"),
			// Sibling branch off u1 never entered plan mode.
			assistant("a2", "u1"),
		]));
		expect(result.map((entry) => [entry.id, entry.mode])).toEqual([["a1", "plan"], ["a2", "main"]]);
	});

	it("buckets nested subagent results per model with deterministic synthetic ids and turns", () => {
		const result = classifySessionEntries(asEntries([
			toolResult("t1", null, "subagent", {
				details: { results: [
					{ model: "gpt-4o", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 }, turns: 3 } },
					{ model: "gpt-4o-mini", usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0, cost: { total: 0.05 }, turns: 2 } },
				] },
			}),
		]));
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ id: "t1:0", mode: "subagent", model: "gpt-4o", input: 10, turns: 3, cost: 0.1 });
		expect(result[1]).toMatchObject({ id: "t1:1", mode: "subagent", model: "gpt-4o-mini", input: 7, turns: 2 });
	});

	it("buckets message-level subagent aggregate usage without double counting", () => {
		const result = classifySessionEntries(asEntries([
			toolResult("t2", null, "subagent", {
				usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.2 }, turns: 5 },
				details: { results: [{ model: "gpt-4o", usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: { total: 9 }, turns: 9 } }] },
			}),
		]));
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ id: "t2", mode: "subagent", input: 1, turns: 5 });
	});

	it("buckets advisor usage with the delegated model from details", () => {
		const result = classifySessionEntries(asEntries([
			toolResult("t3", null, "advisor", { usage: USAGE, details: { model: "deepseek/advisor-v2" } }),
		]));
		expect(result[0]).toMatchObject({ id: "t3", mode: "advisor", model: "deepseek/advisor-v2", input: 100 });
	});

	it("buckets guardian verdicts from custom and custom_message entries", () => {
		const result = classifySessionEntries(asEntries([
			{ type: "custom", id: "v1", parentId: null, timestamp: TS, customType: "auto-review-verdict", data: { model: "openai-codex/gpt-5.6-luna", usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } } } },
			{ type: "custom_message", id: "v2", parentId: null, timestamp: TS, customType: "auto-review-verdict", content: "", display: false, details: { model: "openai/gpt-5", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } },
		]));
		expect(result.map((entry) => [entry.id, entry.mode, entry.model])).toEqual([
			["v1", "guardian", "openai-codex/gpt-5.6-luna"],
			["v2", "guardian", "openai/gpt-5"],
		]);
	});

	it("follows the current mode for compaction and branch summaries", () => {
		const result = classifySessionEntries(asEntries([
			planState("p1", null, { active: true }),
			assistant("a1", "p1"),
			{ type: "compaction", id: "c1", parentId: "a1", timestamp: TS, summary: "s", tokensBefore: 10, usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
			planState("p2", "c1", { active: false }),
			{ type: "branch_summary", id: "b1", parentId: "p2", timestamp: TS, summary: "s", fromId: "a1", usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } },
		]));
		expect(result.map((entry) => [entry.id, entry.mode])).toEqual([["a1", "plan"], ["c1", "plan"], ["b1", "main"]]);
	});

	it("repoints the current model on model_change entries", () => {
		const result = classifySessionEntries(asEntries([
			assistant("a1", null, "gpt-5", "openai"),
			{ type: "model_change", id: "m1", parentId: "a1", timestamp: TS, provider: "anthropic", modelId: "claude-x" },
			toolResult("t1", "m1", "read", { usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } }),
			assistant("a2", "t1", "claude-x"),
		]));
		expect(result.map((entry) => [entry.id, entry.model])).toEqual([
			["a1", "openai/gpt-5"],
			["t1", "anthropic/claude-x"],
			["a2", "anthropic/claude-x"],
		]);
	});

	it("skips session header entries", () => {
		const result = classifySessionEntries(asEntries([
			{ type: "session", version: 3, id: "hdr", timestamp: TS, cwd: "/repo" },
			assistant("a1", null),
		]));
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ id: "a1", mode: "main" });
	});

	it("falls back to the current session model for advisor and guardian entries without model metadata", () => {
		const result = classifySessionEntries(asEntries([
			assistant("a1", null, "claude-x"),
			toolResult("t1", "a1", "advisor", { usage: { input: 5, output: 1, cost: { total: 0.02 } } }),
			{ type: "custom", id: "v1", parentId: "a1", timestamp: TS, customType: "auto-review-verdict", data: { usage: { input: 3, output: 1, cost: { total: 0.01 } } } },
		]));
		expect(result.map((entry) => [entry.id, entry.model])).toEqual([
			["a1", "anthropic/claude-x"],
			["t1", "anthropic/claude-x"],
			["v1", "anthropic/claude-x"],
		]);
	});

	it("counts non-delegated tool result usage as main with the current model", () => {
		const result = classifySessionEntries(asEntries([
			assistant("a1", null, "claude-x"),
			toolResult("t1", "a1", "read", { usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } }),
		]));
		expect(result[1]).toMatchObject({ id: "t1", mode: "main", model: "anthropic/claude-x", input: 3 });
	});

	it("ignores entries without usage and malformed usage records", () => {
		const result = classifySessionEntries(asEntries([
			{ type: "message", id: "u1", parentId: null, timestamp: TS, message: { role: "user", content: "hi" } },
			toolResult("t1", "u1", "read"),
			toolResult("t2", "u1", "subagent", { details: { results: [{ model: "gpt-4o", usage: { input: "x" } }] } }),
			assistant("a1", "u1", "claude-x", "anthropic", { input: Number.NaN, output: -2, cacheRead: Infinity, cacheWrite: -1, cost: {} }),
		]));
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ id: "a1", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
	});
});

describe("buildGlobalUsageSnapshot", () => {
	it("dedups forked copies, attributing copied entries to the original session", () => {
		const copied = [usageEntry("e1", "main", "anthropic/claude-x", 100, 0.25), usageEntry("e2", "main", "anthropic/claude-x", 50, 0.1)];
		const snapshot = buildGlobalUsageSnapshot([
			record("/sessions/p.jsonl", "pid", "2026-01-01T00:00:00.000Z", copied),
			record("/sessions/f.jsonl", "fid", "2026-01-02T00:00:00.000Z", [
				...copied,
				usageEntry("e3", "main", "openai/gpt-5", 10, 0.02),
			]),
		]);
		expect(snapshot.total.input).toBe(160);
		expect(snapshot.total.turns).toBe(3);
		const parent = snapshot.sessions.find((session) => session.id === "pid")!;
		const fork = snapshot.sessions.find((session) => session.id === "fid")!;
		expect(parent.total.input).toBe(150);
		expect(fork.total.input).toBe(10);
		expect(fork.total.turns).toBe(1);
	});

	it("aggregates exclusive buckets and a grand total", () => {
		const snapshot = buildGlobalUsageSnapshot([record("/s.jsonl", "s1", "2026-01-01T00:00:00.000Z", [
			usageEntry("a1", "main", "anthropic/claude-x", 100, 0.25),
			usageEntry("a2", "plan", "anthropic/claude-x", 40, 0.1),
			usageEntry("a3", "subagent", "openai/gpt-4o", 10, 0.02, 3),
			usageEntry("a4", "advisor", "deepseek/advisor", 5, 0.01, 0),
			usageEntry("a5", "guardian", "openai-codex/gpt-5.6-luna", 3, 0.005, 0),
		])]);
		expect(snapshot.totals.main.input).toBe(100);
		expect(snapshot.totals.plan.input).toBe(40);
		expect(snapshot.totals.subagent.turns).toBe(3);
		expect(snapshot.total.input).toBe(158);
		expect(snapshot.total.tokens).toBe(158);
		expect(snapshot.total.cost).toBeCloseTo(0.385);
		expect(snapshot.total.turns).toBe(5);
		expect(snapshot.models.subagent[0]).toMatchObject({ model: "openai/gpt-4o", usage: { turns: 3 } });
		expect(snapshot.modelCount).toBe(4);
	});

	it("sorts model rows by total tokens with unknown last and excludes unknown from the model count", () => {
		const snapshot = buildGlobalUsageSnapshot([record("/s.jsonl", "s1", "2026-01-01T00:00:00.000Z", [
			usageEntry("a1", "main", "unknown", 5),
			usageEntry("a2", "main", "openai/gpt-5", 50),
			usageEntry("a3", "main", "anthropic/claude-x", 100),
			// cacheWrite counts toward the total: 10 input + 200 cacheWrite = 210.
			{ ...usageEntry("a4", "main", "ollama/local", 10), cacheWrite: 200 },
		])]);
		expect(snapshot.models.main.map((row) => row.model)).toEqual(["ollama/local", "anthropic/claude-x", "openai/gpt-5", "unknown"]);
		expect(snapshot.modelCount).toBe(3);
	});

	it("deduplicates copied fork records by parent ancestry, regardless of input order", () => {
		const parent = record("/sessions/parent.jsonl", "pid", "2026-01-01T00:00:00.000Z", [usageEntry("copied", "main", "m1", 10)]);
		const fork = {
			...record("/sessions/fork.jsonl", "fid", "2026-01-02T00:00:00.000Z", [
				usageEntry("copied", "main", "m1", 10),
				usageEntry("fork-only", "main", "m1", 20),
			]),
			parentSession: parent.file,
		};
		const snapshot = buildGlobalUsageSnapshot([fork, parent]);
		expect(snapshot.total.input).toBe(30);
		expect(snapshot.sessions.find((session) => session.id === "pid")?.total.input).toBe(10);
		expect(snapshot.sessions.find((session) => session.id === "fid")?.total.input).toBe(20);
	});

	it("deduplicates global tool runs while keeping fork chat lengths complete", () => {
		const copiedActivity = [
			{ id: "assistant-1", kind: "assistant" as const },
			{ id: "tool-1", kind: "tool" as const, toolName: "read" },
			{ id: "tool-2", kind: "tool" as const, toolName: "read" },
		];
		const snapshot = buildGlobalUsageSnapshot([
			record("/sessions/p.jsonl", "pid", "2026-01-01T00:00:00.000Z", [usageEntry("e1", "main", "m1", 10)],),
			record("/sessions/f.jsonl", "fid", "2026-01-02T00:00:00.000Z", [usageEntry("e2", "main", "m1", 20)],),
		].map((item, index) => ({
			...item,
			activity: index === 0
				? copiedActivity
				: [...copiedActivity, { id: "assistant-2", kind: "assistant" as const }, { id: "tool-3", kind: "tool" as const, toolName: "bash" }],
		})));
		const parent = snapshot.sessions.find((session) => session.id === "pid")!;
		const fork = snapshot.sessions.find((session) => session.id === "fid")!;
		expect(parent).toMatchObject({ chatTurns: 1, toolRuns: 2 });
		expect(fork).toMatchObject({ chatTurns: 2, toolRuns: 3 });
		expect(snapshot.tools).toEqual([{ tool: "read", runs: 2 }, { tool: "bash", runs: 1 }]);
		expect(snapshot.toolRunCount).toBe(3);
	});

	it("orders sessions by cost desc then tokens desc", () => {
		const snapshot = buildGlobalUsageSnapshot([
			record("/a.jsonl", "sa", "2026-01-01T00:00:00.000Z", [usageEntry("a1", "main", "m1", 10, 0.01)]),
			record("/b.jsonl", "sb", "2026-01-02T00:00:00.000Z", [usageEntry("b1", "main", "m1", 20, 0.5)]),
			record("/c.jsonl", "sc", "2026-01-03T00:00:00.000Z", [usageEntry("c1", "main", "m1", 200, 0.5)]),
		]);
		expect(snapshot.sessions.map((session) => session.id)).toEqual(["sc", "sb", "sa"]);
	});
});

describe("scanGlobalUsage store", () => {
	let dir: string;
	let sessionsDir: string;
	let cachePath: string;
	let projectDir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "global-usage-test-"));
		sessionsDir = path.join(dir, "sessions");
		projectDir = path.join(sessionsDir, "--repo--");
		fs.mkdirSync(projectDir, { recursive: true });
		cachePath = path.join(dir, "ledger.json");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function writeSession(fileName: string, headerId: string, created: string, lines: unknown[]): string {
		const file = path.join(projectDir, fileName);
		const header = { type: "session", version: 3, id: headerId, timestamp: created, cwd: "/repo" };
		fs.writeFileSync(file, [JSON.stringify(header), ...lines.map((line) => JSON.stringify(line))].join("\n") + "\n");
		return file;
	}

	it("scans sessions, persists the ledger, and reuses it when nothing changed", async () => {
		writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [
			assistant("a1", null),
			assistant("a2", "a1"),
		]);
		const first = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(first.sessions).toHaveLength(1);
		expect(first.sessions[0]).toMatchObject({ id: "hdr-1", cwd: "/repo", messageCount: 2 });
		expect(first.total.input).toBe(200);
		expect(first.total.turns).toBe(2);
		expect(first.timeline).toHaveLength(2);
		expect(first.timeline[0]?.timestamp).toBe(Date.parse(TS));
		expect(fs.existsSync(cachePath)).toBe(true);
		const ledgerAfterFirst = fs.readFileSync(cachePath, "utf8");
		const ledger = JSON.parse(ledgerAfterFirst) as { version: number; files: Record<string, { entries: unknown[][] }> };
		expect(ledger.version).toBe(3);
		expect(Object.values(ledger.files)[0]!.entries[0]).toHaveLength(10);

		const second = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(second.total.input).toBe(200);
		expect(fs.readFileSync(cachePath, "utf8")).toBe(ledgerAfterFirst);
	});

	it("re-parses files whose mtime or size changed", async () => {
		const file = writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [assistant("a1", null)]);
		await scanGlobalUsage({ sessionsDir, cachePath });
		fs.appendFileSync(file, JSON.stringify(assistant("a3", "a1")) + "\n");
		const updated = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(updated.total.input).toBe(200);
		expect(updated.total.turns).toBe(2);
	});

	it("re-parses a v3 cache entry with missing activity metadata", async () => {
		writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [assistant("a1", null), toolResult("t1", "a1", "read")]);
		await scanGlobalUsage({ sessionsDir, cachePath });
		const ledger = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { files: Record<string, { activity: unknown }> };
		const filePath = Object.keys(ledger.files)[0]!;
		delete ledger.files[filePath]!.activity;
		fs.writeFileSync(cachePath, JSON.stringify(ledger));

		const rescanned = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(rescanned.sessions[0]).toMatchObject({ chatTurns: 1, toolRuns: 1 });
		expect(JSON.parse(fs.readFileSync(cachePath, "utf8")).files[filePath].activity).toHaveLength(2);
	});

	it("re-parses when the cached header id no longer matches the file", async () => {
		writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [assistant("a1", null)]);
		await scanGlobalUsage({ sessionsDir, cachePath });
		const ledger = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { files: Record<string, { headerId: string }> };
		const filePath = Object.keys(ledger.files)[0]!;
		ledger.files[filePath]!.headerId = "tampered";
		fs.writeFileSync(cachePath, JSON.stringify(ledger));

		const rescanned = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(rescanned.sessions[0]?.id).toBe("hdr-1");
	});

	it("extracts assistant turns and tool runs, including tools without usage", async () => {
		writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [
			{ type: "message", id: "u1", parentId: null, timestamp: TS, message: { role: "user", content: "hi" } },
			assistant("a1", "u1"),
			toolResult("t1", "a1", "read"),
			assistant("a2", "t1", "claude-x", "anthropic", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
			assistant("a3", "a2", "claude-x", "anthropic", USAGE, "error"),
		]);
		const snapshot = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(snapshot.sessions[0]).toMatchObject({ chatTurns: 2, toolRuns: 1 });
		expect(snapshot.tools).toEqual([{ tool: "read", runs: 1 }]);
	});

	it("extracts session name, first message, and message count", async () => {
		writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [
			{ type: "session_info", id: "i1", parentId: null, timestamp: TS, name: "Refactor auth" },
			{ type: "message", id: "u1", parentId: null, timestamp: TS, message: { role: "user", content: "Please refactor the auth module" } },
			assistant("a1", "u1"),
			{ type: "session_info", id: "i2", parentId: "a1", timestamp: TS, name: "" },
		]);
		const snapshot = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(snapshot.sessions[0]).toMatchObject({
			name: undefined,
			firstMessage: "Please refactor the auth module",
			messageCount: 2,
		});
	});

	it("drops deleted sessions from the snapshot and the ledger", async () => {
		const file = writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [assistant("a1", null)]);
		writeSession("s2.jsonl", "hdr-2", "2026-01-02T00:00:00.000Z", [assistant("b1", null)]);
		expect((await scanGlobalUsage({ sessionsDir, cachePath })).sessions).toHaveLength(2);
		fs.rmSync(file);
		const snapshot = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.sessions[0]?.id).toBe("hdr-2");
		const ledger = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { files: Record<string, unknown> };
		expect(Object.keys(ledger.files)).toHaveLength(1);
	});

	it("rebuilds a version 1 ledger that has no usage timestamps", async () => {
		writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [assistant("a1", null)]);
		fs.writeFileSync(cachePath, JSON.stringify({ version: 1, updatedAt: 0, files: {} }));
		const snapshot = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(snapshot.timeline[0]?.timestamp).toBe(Date.parse(TS));
		expect(JSON.parse(fs.readFileSync(cachePath, "utf8")).version).toBe(3);
	});

	it("falls back to a full scan on a corrupt ledger", async () => {
		writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [assistant("a1", null)]);
		fs.writeFileSync(cachePath, "{definitely not json");
		const snapshot = await scanGlobalUsage({ sessionsDir, cachePath });
		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.total.input).toBe(100);
		expect(fs.existsSync(cachePath)).toBe(true);
	});

	it("returns an empty snapshot when the sessions directory is missing", async () => {
		const snapshot = await scanGlobalUsage({ sessionsDir: path.join(dir, "nope"), cachePath });
		expect(snapshot.sessions).toHaveLength(0);
		expect(snapshot.total.tokens).toBe(0);
	});

	it("reports progress through the callback", async () => {
		writeSession("s1.jsonl", "hdr-1", "2026-01-01T00:00:00.000Z", [assistant("a1", null)]);
		writeSession("s2.jsonl", "hdr-2", "2026-01-02T00:00:00.000Z", [assistant("b1", null)]);
		const calls: [number, number][] = [];
		await scanGlobalUsage({ sessionsDir, cachePath, onProgress: (loaded, total) => calls.push([loaded, total]) });
		expect(calls).toEqual([[1, 2], [2, 2]]);
	});
});
