import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import steerInputExtension from "./index.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

describe("steer widget", () => {
	it("shows a themed, width-safe hint while the agent is streaming", () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const setWidget = vi.fn();
		steerInputExtension({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			sendUserMessage: vi.fn(),
		} as any);

		const ctx = {
			hasUI: true,
			ui: {
				setWidget,
				setEditorComponent: vi.fn(),
				getEditorComponent: vi.fn(),
				setEditorText: vi.fn(),
				notify: vi.fn(),
			},
		} as any;

		handlers.get("agent_start")!({}, ctx);
		expect(setWidget).toHaveBeenCalledWith("steer-hint", expect.any(Function));

		const factory = setWidget.mock.calls.at(-1)?.[1];
		const widget = factory({}, theme());
		for (const width of [20, 40, 80]) {
			const lines = widget.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		const output = widget.render(80)[0] ?? "";
		expect(output).toContain("Enter");
		expect(output).toContain("Tab");
		expect(output).toContain(" · ");
	});

	it("clears the hint when the agent finishes streaming", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const setWidget = vi.fn();
		steerInputExtension({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			sendUserMessage: vi.fn(),
		} as any);

		const ctx = {
			hasUI: true,
			ui: {
				setWidget,
				setEditorComponent: vi.fn(),
				getEditorComponent: vi.fn(),
				setEditorText: vi.fn(),
				notify: vi.fn(),
			},
		} as any;

		handlers.get("agent_start")!({}, ctx);
		const agentEnd = handlers.get("agent_end")!;
		await agentEnd({}, ctx);
		expect(setWidget).toHaveBeenLastCalledWith("steer-hint", undefined);
	});
});
