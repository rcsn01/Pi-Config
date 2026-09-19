import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import goalExtension from "./index.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
	} as any;
}

function harness(initialBranch: any[] = []) {
	const handlers = new Map<string, any[]>();
	const busHandlers = new Map<string, Set<(data: unknown) => void>>();
	const commands = new Map<string, any>();
	let tool: any;
	let branch = initialBranch;
	let idle = true;
	let pending = false;
	const sendMessage = vi.fn(() => { idle = false; });
	const sendUserMessage = vi.fn(() => { idle = false; });
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (definition: any) => { tool = definition; },
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		appendEntry: vi.fn(),
		sendMessage,
		sendUserMessage,
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				const set = busHandlers.get(channel) ?? new Set();
				set.add(handler);
				busHandlers.set(channel, set);
				return () => set.delete(handler);
			},
			emit: (channel: string, data: unknown) => {
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			},
		},
	};
	const ctx: any = {
		sessionManager: { getBranch: () => branch },
		ui: { notify: vi.fn(), setWidget: vi.fn(), confirm: vi.fn(async () => true) },
		hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	};
	goalExtension(pi as any);
	const emit = async (event: string, payload: any = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
		return result;
	};
	const runCommand = async (args: string, context = ctx) => commands.get("goal")?.handler(args, context);
	return {
		handlers, commands, tool, ctx, emit, runCommand,
		appendEntry: pi.appendEntry, sendMessage, sendUserMessage, emitBus: pi.events.emit,
		setBranch(next: any[]) { branch = next; },
		setIdle(next: boolean) { idle = next; },
		setPending(next: boolean) { pending = next; },
		setConfirm(next: () => Promise<boolean>) { ctx.ui.confirm.mockImplementation(next); },
	};
}

function activeGoalEntry(objective = "Ship the release", status = "active") {
	return {
		type: "custom",
		id: "goal-entry",
		customType: "goal-state",
		data: { action: "set", state: { goalId: "goal-1", objective, status, createdAt: 1, updatedAt: 1 } },
	};
}

function runtimeEntry(overrides: Record<string, unknown> = {}) {
	return {
		type: "custom",
		id: "runtime-entry",
		customType: "goal-runtime",
		data: {
			goalId: "goal-1",
			continuationRuns: 0,
			consecutiveNoProgressRuns: 0,
			consecutiveFailureRuns: 0,
			updatedAt: 1,
			...overrides,
		},
	};
}

describe("goal tool rendering and failure states", () => {
	it("renders compact success summaries and expanded content", () => {
		const { tool } = harness();
		const result = {
			content: [{ type: "text", text: "✓ Goal completed: Done" }],
			details: { action: "complete" },
		};
		expect(tool.renderResult(result, { expanded: false, isPartial: false }, theme(), { isError: false }).render(80).join("\n"))
			.toContain("✓ Goal completed · expand to view");
		expect(tool.renderResult(result, { expanded: true, isPartial: false }, theme(), { isError: false }).render(80).join("\n"))
			.toContain("✓ Goal completed: Done");
	});

	it("marks checkpoint without an active goal as a tool error", async () => {
		const { tool } = harness();
		const result = await tool.execute("call", { action: "checkpoint", summary: "No" }, undefined, undefined, {} as any);
		expect(result).toMatchObject({ isError: true, details: { action: "checkpoint", error: "No active goal." } });
		expect(tool.renderResult(result, { expanded: false, isPartial: false }, theme(), { isError: false })
			.render(80).join("\\n")).toContain("✗ No active goal.");
	});

	it("preserves the empty checkpoint error shape", async () => {
		const h = harness([activeGoalEntry(), runtimeEntry()]);
		await h.emit("session_start");
		const result = await h.tool.execute("call", { action: "checkpoint", summary: "  " }, undefined, undefined, h.ctx);
		expect(result).toMatchObject({ isError: true, details: { action: "checkpoint", error: "Cannot checkpoint: a non-empty summary is required." } });
		expect(result.details).not.toHaveProperty("state");
	});

	it("marks rejected checkpoint transitions as tool errors", async () => {
		const { handlers, tool, ctx } = harness([{
			type: "custom",
			customType: "goal-state",
			data: { action: "pause", state: { objective: "Keep going", status: "paused", createdAt: 1, updatedAt: 1 } },
		}]);
		await handlers.get("session_start")?.[0]({}, ctx);
		const result = await tool.execute("call", { action: "checkpoint", summary: "No" }, undefined, undefined, ctx);
		expect(result).toMatchObject({ isError: true, content: [{ text: "Cannot checkpoint: goal is paused." }] });
		expect(handlers.get("tool_result")?.[0]({
			toolName: "goal",
			content: result.content,
			details: result.details,
			isError: false,
		})).toEqual({ isError: true });
		const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, theme(), { isError: true });
		expect(rendered.render(80).join("\n")).toContain("✗ Cannot checkpoint");
	});
});

describe("goal status widget", () => {
	it("mounts a themed, width-safe goal widget while a goal is active", async () => {
		const { handlers, ctx } = harness([{
			type: "custom",
			customType: "goal-state",
			data: {
				action: "set",
				state: { objective: "Working through the release", status: "active", createdAt: 1, updatedAt: 1 },
			},
		}]);

		await handlers.get("session_start")?.[0]({}, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("goal-status", expect.any(Function));

		const factory = ctx.ui.setWidget.mock.calls.at(-1)?.[1];
		const widget = factory({}, theme());
		for (const width of [20, 40, 80]) {
			const lines = widget.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		const output = widget.render(80).join("\n");
		expect(output).toContain("Working through the release");
		expect(output).toContain("Goal");
	});

	it("clears the goal widget when no goal is active", async () => {
		const { handlers, ctx } = harness();

		await handlers.get("session_start")?.[0]({}, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("goal-status", undefined);
	});
});

describe("goal adapter boundaries", () => {
	it("ignores malformed compaction payloads at the bus boundary", async () => {
		const h = harness([activeGoalEntry(), runtimeEntry()]);
		await h.emit("session_start");
		h.emitBus("session-compaction:state", { inProgress: true, source: "turn_end", resumesRun: true, succeeded: undefined });
		h.emitBus("session-compaction:state", { inProgress: false, source: "turn_end", resumesRun: false, error: 3 });
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.appendEntry).not.toHaveBeenCalled();
	});

	it("applies an idle compaction finish before the bus emit returns", async () => {
		const h = harness([activeGoalEntry(), runtimeEntry()]);
		await h.emit("session_start");
		await h.emit("agent_settled");
		await h.emit("message_start", { message: { role: "custom", customType: "goal-continuation", details: { goalId: "goal-1" } } });
		h.setIdle(true);
		h.emitBus("session-compaction:state", { inProgress: true, source: "turn_end", resumesRun: false });
		await h.emit("agent_settled");
		h.sendMessage.mockClear();
		h.emitBus("session-compaction:state", { inProgress: false, source: "turn_end", resumesRun: false, succeeded: true });
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("reinstalls the compaction listener after a normal shutdown", async () => {
		const h = harness([activeGoalEntry(), runtimeEntry()]);
		await h.emit("session_start");
		await h.emit("session_shutdown");
		await h.emit("session_start");
		await h.emit("agent_settled");
		await h.emit("message_start", { message: { role: "custom", customType: "goal-continuation", details: { goalId: "goal-1" } } });
		h.setIdle(true);
		h.emitBus("session-compaction:state", { inProgress: true, source: "turn_end", resumesRun: false });
		await h.emit("agent_settled");
		h.sendMessage.mockClear();
		h.emitBus("session-compaction:state", { inProgress: false, source: "turn_end", resumesRun: false, succeeded: true });
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("does not let an old shutdown remove a replacement host's compaction listener", async () => {
		const h = harness([activeGoalEntry(), runtimeEntry()]);
		await h.emit("session_start");
		let resolveConfirmation!: (accepted: boolean) => void;
		h.setConfirm(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }));
		const command = h.runCommand("Replace this goal");
		await vi.waitFor(() => expect(h.ctx.ui.confirm).toHaveBeenCalledOnce());
		const shutdown = h.handlers.get("session_shutdown")?.[0]?.();
		const replacement = h.emit("session_start");
		resolveConfirmation(true);
		await Promise.all([command, shutdown, replacement]);
		await h.emit("agent_settled");
		await h.emit("message_start", { message: { role: "custom", customType: "goal-continuation", details: { goalId: "goal-1" } } });
		h.setIdle(true);
		h.emitBus("session-compaction:state", { inProgress: true, source: "turn_end", resumesRun: false });
		await h.emit("agent_settled");
		h.sendMessage.mockClear();
		h.emitBus("session-compaction:state", { inProgress: false, source: "turn_end", resumesRun: false, succeeded: true });
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});
});

describe("goal command surface", () => {
	it("sets a goal, persists it, and kicks off work", async () => {
		const { runCommand, ctx, appendEntry, sendUserMessage } = harness();
		await runCommand("Write the docs");

		expect(ctx.ui.notify).toHaveBeenCalledWith('Goal set: "Write the docs"', "info");
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("goal-status", expect.any(Function));
		expect(appendEntry).toHaveBeenCalledWith("goal-state", {
			action: "set",
			state: expect.objectContaining({ objective: "Write the docs", status: "active" }),
		});
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Goal: Write the docs"));
	});

	it("queues a kickoff when the command runs while busy", async () => {
		const h = harness();
		h.setIdle(false);
		await h.runCommand("Write the docs");
		expect(h.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Goal: Write the docs"),
			{ deliverAs: "followUp" },
		);
	});
});

describe("goal completion contract", () => {
	it("preserves checkpoint remaining text and trims mutation inputs", async () => {
		const checkpoint = harness([activeGoalEntry(), runtimeEntry()]);
		await checkpoint.emit("session_start");
		const saved = await checkpoint.tool.execute("call", { action: "checkpoint", summary: " Progress ", remaining: "  investigate the cache  " }, undefined, undefined, checkpoint.ctx);
		expect(saved).toMatchObject({ content: [{ text: "Checkpoint: Progress\nRemaining:   investigate the cache  " }], details: { state: { checkpointProgress: "Progress" } } });

		const blocked = harness([activeGoalEntry(), runtimeEntry()]);
		await blocked.emit("session_start");
		const stopped = await blocked.tool.execute("call", { action: "blocked", reason: " Needs access " }, undefined, undefined, blocked.ctx);
		expect(stopped).toMatchObject({ content: [{ text: "Goal blocked: Needs access" }], details: { state: { blockedReason: "Needs access" } } });
	});

	it("rejects missing or failed evidence and accepts passing evidence", async () => {
		const h = harness([activeGoalEntry(), runtimeEntry()]);
		await h.emit("session_start");
		const missing = await h.tool.execute("call", { action: "complete", summary: "Done" }, undefined, undefined, h.ctx);
		expect(missing).toMatchObject({ isError: true, details: { action: "complete" } });
		const failed = await h.tool.execute("call", {
			action: "complete",
			summary: "Done",
			evidence: [{ requirement: "Tests", verification: "pnpm test", result: "failed" }],
		}, undefined, undefined, h.ctx);
		expect(failed).toMatchObject({ isError: true });

		const accepted = await h.tool.execute("call", {
			action: "complete",
			summary: "Done",
			evidence: [{ requirement: "Tests", verification: "pnpm test passed", result: "passed" }],
		}, undefined, undefined, h.ctx);
		expect(accepted).not.toHaveProperty("isError", true);
		expect(h.appendEntry).toHaveBeenCalledWith("goal-state", expect.objectContaining({
			action: "complete",
			state: expect.objectContaining({ status: "completed", completionEvidence: expect.any(Array) }),
		}));
		expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
		await h.emit("turn_end", { message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
	});
});
