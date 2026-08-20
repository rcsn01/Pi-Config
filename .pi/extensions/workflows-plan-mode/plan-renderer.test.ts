import { describe, expect, it, vi } from "vitest";
import { registerPlanRenderers, updatePlanStatus } from "./plan-renderer.ts";

function theme() {
	const identity = (_color: string, text: string) => text;
	return {
		fg: identity,
		bg: identity,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
	} as any;
}

function registeredRenderers() {
	const messages = new Map<string, any>();
	const entries = new Map<string, any>();
	registerPlanRenderers({
		registerMessageRenderer: (type: string, renderer: any) => messages.set(type, renderer),
		registerEntryRenderer: (type: string, renderer: any) => entries.set(type, renderer),
	} as any);
	return { messages, entries };
}

describe("Plan Mode rendering", () => {
	it("registers and renders backward-compatible proposed-plan messages", () => {
		const { messages } = registeredRenderers();
		expect([...messages.keys()]).toEqual(["proposed-plan"]);
		const component = messages.get("proposed-plan")({
			content: "# Legacy Plan\n\n- Keep compatibility",
			details: { createdAt: 0 },
		}, { expanded: false }, theme());
		const output = component.render(100).join("\n");
		expect(output).toContain("Proposed Plan");
		expect(output).toContain("Plan ready · expand to view");
		expect(output).not.toContain("Keep compatibility");
	});

	it("renders transcript-only proposed-plan-display entries", () => {
		const { entries } = registeredRenderers();
		expect([...entries.keys()]).toEqual(["proposed-plan-display"]);
		const component = entries.get("proposed-plan-display")({
			data: { content: "## Current Plan\n\nUse **Markdown**." },
		}, { expanded: false }, theme());
		const output = component.render(100).join("\n");
		expect(output).toContain("Proposed Plan");
		expect(output).toContain("Plan ready · expand to view");
	});

	it("normalizes array custom-message content when expanded", () => {
		const { messages } = registeredRenderers();
		const component = messages.get("proposed-plan")({
			content: [{ type: "text", text: "# Array plan" }, { type: "text", text: "\nDone." }],
			details: { createdAt: 0 },
		}, { expanded: true }, theme());
		const output = component.render(100).join("\n");
		expect(output).toContain("Array plan");
		expect(output).toContain("Done.");
	});

	it("shows timestamps only when expanded", () => {
		const { entries } = registeredRenderers();
		const renderer = entries.get("proposed-plan-display");
		const data = { content: "Plan", createdAt: Date.UTC(2026, 0, 1) };
		expect(renderer({ data }, { expanded: false }, theme()).render(100).join("\n"))
			.not.toContain("created");
		expect(renderer({ data }, { expanded: true }, theme()).render(100).join("\n"))
			.toContain("created");
	});

	it("renders inactive, planning, and review status snapshots", () => {
		const setStatus = vi.fn();
		const ctx = { ui: { setStatus } } as any;
		const base = { revision: 1, changedAt: "2026-01-01T00:00:00.000Z" };
		updatePlanStatus(ctx, { ...base, mode: "default" });
		updatePlanStatus(ctx, { ...base, mode: "plan", phase: "planning" });
		updatePlanStatus(ctx, { ...base, mode: "plan", phase: "awaiting_review" });
		expect(setStatus.mock.calls).toEqual([
			["plan", undefined],
			["plan", "📋 plan"],
			["plan", "📋 plan review"],
		]);
	});
});
