import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdvisorExtension } from "./index.ts";
import { ADVISOR_NUDGE_CUSTOM_TYPE } from "./runner.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function settingsFile(advisor: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "advisor-nudge-"));
	roots.push(root);
	const path = join(root, "settings.json");
	writeFileSync(path, JSON.stringify({ advisor }));
	return path;
}

function userEntry(id: string): any {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: "Do the task", timestamp: 0 },
	};
}

function assistantEntry(id: string): any {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `Turn ${id}` }],
			api: "test",
			provider: "test",
			model: "executor",
			usage: {},
			stopReason: "toolUse",
			timestamp: 0,
		},
	};
}

function branchWithAssistants(count: number): any[] {
	const entries = [userEntry("user-1")];
	for (let index = 0; index < count; index++) entries.push(assistantEntry(`assistant-${index + 1}`));
	return entries;
}

function advisorResult(id: string): any {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "advisor",
			isError: false,
			content: [{ type: "text", text: "Advice" }],
			details: { consumesBudget: true },
			timestamp: 0,
		},
	};
}

function nudgeEntry(): any {
	return {
		type: "custom_message",
		id: "nudge",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: ADVISOR_NUDGE_CUSTOM_TYPE,
		content: "nudge",
		display: false,
	};
}

function makeHarness(advisor: Record<string, unknown>, entries = branchWithAssistants(0)) {
	const settingsPath = settingsFile(advisor);
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const sendMessage = vi.fn();
	let activeTools: string[] = [];
	const pi: any = {
		on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler)),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((names: string[]) => { activeTools = [...names]; }),
		getAllTools: vi.fn(() => []),
		sendMessage,
	};
	const ctx: any = {
		cwd: "/workspace",
		mode: "print",
		hasUI: false,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		sessionManager: { getBranch: () => entries },
	};
	createAdvisorExtension({ settingsPath })(pi);
	return { handlers, ctx, entries, sendMessage };
}

async function runTurn(harness: ReturnType<typeof makeHarness>, currentMessage?: any): Promise<void> {
	await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
	const last = harness.entries[harness.entries.length - 1];
	await harness.handlers.get("turn_end")?.({
		type: "turn_end",
		turnIndex: 0,
		message: currentMessage ?? last?.message ?? { role: "user", content: "Do the task", timestamp: 0 },
		toolResults: [],
	}, harness.ctx);
}

describe("strict advisor nudge", () => {
	it.each([
		["advisor off", { strict: true }],
		["strict false", { provider: "test", modelId: "advisor", strict: false }],
		["fewer than nudgeTurn assistant turns", { provider: "test", modelId: "advisor", strict: true, entries: branchWithAssistants(2) }],
		["advisor already consulted this user turn", { provider: "test", modelId: "advisor", strict: true, entries: [...branchWithAssistants(3), advisorResult("advisor-1")] }],
		["nudge already sent this user turn", { provider: "test", modelId: "advisor", strict: true, entries: [...branchWithAssistants(3), nudgeEntry()] }],
		["per-turn budget exhausted", { provider: "test", modelId: "advisor", strict: true, entries: [...branchWithAssistants(3), advisorResult("advisor-1"), advisorResult("advisor-2"), advisorResult("advisor-3")] }],
		["per-session budget exhausted", { provider: "test", modelId: "advisor", strict: true, maxUsesPerSession: 3, entries: [...branchWithAssistants(3), advisorResult("advisor-1"), advisorResult("advisor-2"), advisorResult("advisor-3")] }],
	] as const)("does not nudge when %s", async (_name, options) => {
		const { entries, ...advisor } = options as { entries?: any[] } & Record<string, unknown>;
		const harness = makeHarness(advisor, entries ?? branchWithAssistants(3));
		await runTurn(harness);
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("nudges with a hidden steer without starting a turn", async () => {
		const harness = makeHarness({ provider: "test", modelId: "advisor", strict: true });
		harness.entries.push(...branchWithAssistants(3).slice(1));
		await runTurn(harness);
		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: ADVISOR_NUDGE_CUSTOM_TYPE, display: false, content: expect.stringContaining("call advisor") }),
		{ deliverAs: "steer", triggerTurn: false },
		);
	});

	it("counts the current turn_end response before Pi persists it", async () => {
		const harness = makeHarness({ provider: "test", modelId: "advisor", strict: true }, branchWithAssistants(2));
		const currentAssistant = assistantEntry("assistant-3").message;
		await runTurn(harness, currentAssistant);
		expect(harness.sendMessage).toHaveBeenCalledOnce();
	});

	it("becomes eligible again after a new user message", async () => {
		const harness = makeHarness({ provider: "test", modelId: "advisor", strict: true });
		harness.entries.push(...branchWithAssistants(3).slice(1));
		await runTurn(harness);
		harness.entries.push(nudgeEntry(), userEntry("user-2"), ...branchWithAssistants(3).slice(1));
		await runTurn(harness);
		expect(harness.sendMessage).toHaveBeenCalledTimes(2);
	});
});
