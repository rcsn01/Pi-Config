import type { ContextUsage, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	collectEfficiencyMetrics,
	efficiencyLevel,
	isRecognizedTestCommand,
} from "./budget-model.ts";
import efficiencyGuardrailExtension from "./index.ts";

function usage(cost: number) {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistantEntry(index: number, options: { cost?: number; command?: string } = {}): SessionEntry {
	return {
		type: "message",
		id: `assistant-${index}`,
		parentId: index > 0 ? `assistant-${index - 1}` : null,
		timestamp: new Date(index).toISOString(),
		message: {
			role: "assistant",
			content: options.command ? [{
				type: "toolCall",
				id: `tool-${index}`,
				name: "bash",
				arguments: { command: options.command },
			}] : [{ type: "text", text: "working" }],
			usage: usage(options.cost ?? 0.01),
			stopReason: "stop",
			timestamp: index,
		},
	} as SessionEntry;
}

function stateEntry(level: "checkpoint" | "strong"): SessionEntry {
	return {
		type: "custom",
		id: `state-${level}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "efficiency-guardrail-state",
		data: { level },
	} as SessionEntry;
}

function createHarness(initialEntries: SessionEntry[], initialContextPercent = 10) {
	const entries = [...initialEntries];
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, any>();
	const sentMessages: any[] = [];
	const appendedEntries: any[] = [];
	const setStatus = vi.fn();
	const notify = vi.fn();
	let contextPercent = initialContextPercent;
	const contextUsage = (): ContextUsage => ({
		tokens: contextPercent * 1_000,
		contextWindow: 100_000,
		percent: contextPercent,
	});
	const ctx = {
		ui: { setStatus, notify },
		sessionManager: { getEntries: () => [...entries] },
		getContextUsage: contextUsage,
		isIdle: () => true,
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (customType: string, data: unknown) => {
			appendedEntries.push({ customType, data });
			entries.push({
				type: "custom",
				id: `appended-${entries.length}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			} as SessionEntry);
		},
		sendMessage: (message: unknown, options: unknown) => sentMessages.push({ message, options }),
	};
	efficiencyGuardrailExtension(pi as any);
	return {
		entries,
		handlers,
		commands,
		sentMessages,
		appendedEntries,
		setStatus,
		notify,
		ctx,
		setContextPercent: (percent: number) => { contextPercent = percent; },
		emit: async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
		},
	};
}

describe("efficiency metric model", () => {
	it("aggregates model calls, tool calls, test runs, costs, and context usage", () => {
		const entries = [
			assistantEntry(0, { cost: 0.5, command: "pnpm --dir .pi test:plan" }),
			{
				type: "message", id: "tool-result", parentId: "assistant-0", timestamp: new Date(1).toISOString(),
				message: { role: "toolResult", toolCallId: "tool-0", toolName: "bash", content: [], isError: false, usage: usage(0.2), timestamp: 1 },
			} as SessionEntry,
			{
				type: "compaction", id: "compact", parentId: "tool-result", timestamp: new Date(2).toISOString(),
				summary: "summary", firstKeptEntryId: "assistant-0", tokensBefore: 1_000, usage: usage(0.3),
			} as SessionEntry,
		];
		expect(collectEfficiencyMetrics(entries, { tokens: 65_000, contextWindow: 100_000, percent: 65 })).toEqual({
			modelCalls: 2,
			toolCalls: 1,
			testRuns: 1,
			cost: 1,
			contextPercent: 65,
		});
	});

	it("recognizes common test runners without counting search commands", () => {
		for (const command of [
			"pnpm test", "pnpm --dir .pi test:plan", "npm run test:unit", "npm t", "yarn test", "bun test",
			"vitest", "npx vitest run", "npx jest", "jest", "pytest -q", "python3 -m pytest",
			"go test ./...", "cargo test", "node --test tests/*.mjs", "dotnet test", "mvn -q test", "./gradlew --no-daemon test",
		]) expect(isRecognizedTestCommand(command), command).toBe(true);
		for (const command of [
			"rg -n 'vitest|jest|pytest' src", "npm install test", "npm view test", "pnpm add test", "echo vitest run",
		]) expect(isRecognizedTestCommand(command), command).toBe(false);
	});

	it("selects the highest crossed checkpoint", () => {
		expect(efficiencyLevel({ modelCalls: 29, toolCalls: 100, testRuns: 7, cost: 2.99, contextPercent: 59 })).toBe("none");
		expect(efficiencyLevel({ modelCalls: 30, toolCalls: 0, testRuns: 0, cost: 0, contextPercent: 0 })).toBe("checkpoint");
		expect(efficiencyLevel({ modelCalls: 1, toolCalls: 0, testRuns: 0, cost: 7, contextPercent: 1 })).toBe("strong");
	});
});

describe("efficiency guardrail extension", () => {
	it("emits checkpoint and strong messages once each", async () => {
		const harness = createHarness(Array.from({ length: 30 }, (_, index) => assistantEntry(index)));
		await harness.emit("session_start");
		await harness.emit("turn_end");
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.content).toContain("Efficiency checkpoint");
		expect(harness.appendedEntries).toEqual([{ customType: "efficiency-guardrail-state", data: { level: "checkpoint" } }]);

		harness.entries.push(...Array.from({ length: 30 }, (_, index) => assistantEntry(index + 30)));
		await harness.emit("turn_end");
		await harness.emit("agent_settled");
		expect(harness.sentMessages).toHaveLength(2);
		expect(harness.sentMessages[1].message.content).toContain("strong checkpoint");
		expect(harness.setStatus).toHaveBeenLastCalledWith("efficiency-budget", "‼ efficiency");
	});

	it("restores persisted state across reload, tree navigation, and compaction", async () => {
		const harness = createHarness([
			...Array.from({ length: 30 }, (_, index) => assistantEntry(index)),
			stateEntry("checkpoint"),
		]);
		await harness.emit("session_start");
		await harness.emit("session_tree");
		await harness.emit("session_compact");
		expect(harness.sentMessages).toHaveLength(0);
		expect(harness.appendedEntries).toHaveLength(0);
		expect(harness.setStatus).toHaveBeenLastCalledWith("efficiency-budget", "⚠ efficiency");
	});

	it("remains advisory and reports metrics through /efficiency", async () => {
		const harness = createHarness([assistantEntry(0, { command: "pytest" })], 25);
		expect(harness.handlers.has("tool_call")).toBe(false);
		await harness.commands.get("efficiency").handler("", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("1 model calls · 1 tool calls · 1 test runs"),
			"info",
		);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("Checkpoint: 30 calls"), "info");
	});
});
