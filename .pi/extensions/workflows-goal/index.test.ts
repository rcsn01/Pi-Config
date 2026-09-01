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

function harness(branch: any[] = []) {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	let tool: any;
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (definition: any) => { tool = definition; },
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		appendEntry: vi.fn(),
		sendUserMessage: vi.fn(),
	};
	const ctx: any = {
		sessionManager: { getBranch: () => branch },
		ui: { notify: vi.fn(), setWidget: vi.fn(), confirm: vi.fn(async () => true) },
		hasUI: true,
	};
	goalExtension(pi as any);
	const runCommand = async (args: string, context = ctx) =>
		commands.get("goal")?.handler(args, context);
	return { handlers, commands, tool, ctx, runCommand, appendEntry: pi.appendEntry, sendUserMessage: pi.sendUserMessage };
}

function activeGoalEntry(objective = "Ship the release", status = "active") {
	return {
		type: "custom",
		customType: "goal-state",
		data: { action: "set", state: { objective, status, createdAt: 1, updatedAt: 1 } },
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

	it("marks rejected checkpoint transitions as tool errors", async () => {
		const { handlers, tool, ctx } = harness([{
			type: "custom",
			customType: "goal-state",
			data: { action: "pause", state: { objective: "Keep going", status: "paused", createdAt: 1, updatedAt: 1 } },
		}]);
		await handlers.get("session_start")({}, ctx);
		const result = await tool.execute("call", { action: "checkpoint", summary: "No" }, undefined, undefined, ctx);
		expect(result).toMatchObject({ isError: true, content: [{ text: "Cannot checkpoint: goal is paused." }] });
		expect(handlers.get("tool_result")({
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

		await handlers.get("session_start")({}, ctx);
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

		await handlers.get("session_start")({}, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("goal-status", undefined);
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

	it("views, pauses, resumes, edits, checkpoints, and clears with the documented messages", async () => {
		const { handlers, ctx, runCommand } = harness([activeGoalEntry()]);
		await handlers.get("session_start")({}, ctx);

		await runCommand("");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Goal: Ship the release"),
			"info",
		);

		await runCommand("pause");
		expect(ctx.ui.notify).toHaveBeenCalledWith('Goal paused: "Ship the release"', "info");
		await runCommand("pause");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Goal is already paused.", "warning");

		await runCommand("resume");
		expect(ctx.ui.notify).toHaveBeenCalledWith('Goal resumed: "Ship the release"', "info");
		await runCommand("resume");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Goal is already active.", "warning");

		await runCommand("edit New objective");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Goal updated: New objective", "info");

		await runCommand("checkpoint Tests pass");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Checkpoint saved: Tests pass", "info");

		await runCommand("clear");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Goal cleared.", "info");
		await runCommand("clear");
		expect(ctx.ui.notify).toHaveBeenCalledWith("No goal to clear.", "warning");
	});

	it("rejects transitions from dead goals with the documented messages", async () => {
		const completed = harness([activeGoalEntry("Done", "completed")]);
		await completed.handlers.get("session_start")({}, completed.ctx);
		await completed.runCommand("pause");
		await completed.runCommand("resume");
		expect(completed.ctx.ui.notify).toHaveBeenCalledWith(
			"Goal is already completed. Use /goal <objective> to set a new one.",
			"warning",
		);
		await completed.runCommand("checkpoint Anything");
		expect(completed.ctx.ui.notify).toHaveBeenCalledWith("No active goal to checkpoint.", "warning");
		await completed.runCommand("clear");
		expect(completed.ctx.ui.notify).toHaveBeenCalledWith("Completed goal cleared.", "info");

		const empty = harness();
		await empty.handlers.get("session_start")({}, empty.ctx);
		await empty.runCommand("");
		await empty.runCommand("pause");
		await empty.runCommand("resume");
		await empty.runCommand("edit Next");
		await empty.runCommand("checkpoint Thing");
		const messages = empty.ctx.ui.notify.mock.calls.map((call: any[]) => call[0]);
		expect(messages).toEqual([
			"No active goal. Use /goal <objective> to set one.",
			"No active goal to pause.",
			"No goal to resume.",
			"No active goal to edit.",
			"No active goal to checkpoint.",
		]);
	});

	it("confirms replacement of an active goal and persists each transition", async () => {
		const { handlers, ctx, runCommand, appendEntry } = harness([activeGoalEntry("Original")]);
		await handlers.get("session_start")({}, ctx);

		ctx.ui.confirm.mockResolvedValueOnce(false);
		await runCommand("Replacement goal");
		expect(ctx.ui.confirm).toHaveBeenCalledWith(
			"Replace goal?",
			expect.stringContaining('An active goal already exists: "Original"'),
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith('Goal set: "Replacement goal"', "info");
		expect(appendEntry).not.toHaveBeenCalled();

		ctx.ui.confirm.mockResolvedValueOnce(true);
		await runCommand("Replacement goal");
		expect(ctx.ui.notify).toHaveBeenCalledWith('Goal set: "Replacement goal"', "info");
		expect(appendEntry).toHaveBeenCalledWith("goal-state", {
			action: "set",
			state: expect.objectContaining({ objective: "Replacement goal", status: "active" }),
		});
	});

	it("rejects oversized objectives before any confirmation", async () => {
		const { handlers, ctx, runCommand } = harness([activeGoalEntry()]);
		await handlers.get("session_start")({}, ctx);

		await runCommand("x".repeat(4001));

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Goal objective too long (max 4000 characters). Put details in a file and reference it.",
			"error",
		);
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});
});
