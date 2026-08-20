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
	let tool: any;
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (definition: any) => { tool = definition; },
		registerCommand: vi.fn(),
		appendEntry: vi.fn(),
		sendUserMessage: vi.fn(),
	};
	const ctx: any = {
		sessionManager: { getBranch: () => branch },
		ui: { notify: vi.fn(), setWidget: vi.fn() },
		hasUI: true,
	};
	goalExtension(pi as any);
	return { handlers, tool, ctx };
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
