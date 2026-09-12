import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { declareStatus } from "../_shared/status-registry.ts";
import footerExtension from "./index.ts";

declareStatus({ id: "profile", style: "muted", order: 10 });
declareStatus({ id: "approval-mode", style: "muted", order: 20 });
declareStatus({ id: "plan", style: "accent", order: 30 });
declareStatus({ id: "plan-pending", style: "accent", order: 40 });
declareStatus({ id: "plan-runtime", style: "warning", order: 50 });
declareStatus({ id: "workflow", style: "accent", order: 60 });
declareStatus({ id: "side-mode", style: "accent", order: 70 });
declareStatus({ id: "advisor", style: "muted", order: 80, placement: "right" });
declareStatus({ id: "cache-effort", style: "muted", order: 90 });

function renderFooter(statuses: ReadonlyMap<string, string>, width: number, theme: any = { fg: (_color: string, text: string) => text }): string[] {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const setFooter = vi.fn();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		getThinkingLevel: () => "off",
	};
	const ctx = {
		ui: { setFooter },
		sessionManager: {
			getEntries: () => [],
			getCwd: () => "/workspace",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
		model: { id: "executor", provider: "test", contextWindow: 1000, reasoning: false },
	};

	footerExtension(pi as any);
	const sessionStart = handlers.get("session_start");
	if (!sessionStart) throw new Error("Footer extension did not register session_start.");
	void sessionStart({}, ctx);

	const factory = setFooter.mock.calls[0]?.[0];
	if (!factory) throw new Error("Footer extension did not install a footer.");
	const footerData = {
		onBranchChange: () => () => {},
		getGitBranch: () => null,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
	};
	return factory({}, theme, footerData).render(width);
}

describe("status footer", () => {
	it("orders extension statuses and uses one separator between them", () => {
		const statusLine = renderFooter(new Map([
			["plan", "plan"],
			["other", "other"],
			["approval-mode", "auto-review"],
			["profile", "openai"],
		]), 80)[2] ?? "";

		expect(statusLine).toBe("openai | auto-review | plan | other");
	});

	it("orders plan-runtime, workflow, and side-mode explicitly", () => {
		const statusLine = renderFooter(new Map([
			["side-mode", "side mode"],
			["other", "other"],
			["workflow", "build · running · 1/3 agents"],
			["plan-runtime", "⟳ sandbox"],
			["plan", "plan"],
		]), 120)[2] ?? "";

		expect(statusLine).toBe("plan | ⟳ sandbox | build · running · 1/3 agents | side mode | other");
	});

	it("orders plan-pending between plan and plan-runtime", () => {
		const statusLine = renderFooter(new Map([
			["plan-runtime", "sandbox"],
			["plan-pending", "queued"],
			["plan", "plan"],
		]), 80)[2] ?? "";

		expect(statusLine).toBe("plan | queued | sandbox");
	});

	it("applies semantic styling per status key", () => {
		const colors = new Map<string, string>();
		const theme = {
			fg: (color: string, text: string) => {
				colors.set(color, (colors.get(color) ?? "") + text);
				return text;
			},
		};
		const statusLine = renderFooter(new Map([
			["plan", "plan"],
			["plan-runtime", "⟳ sandbox"],
			["workflow", "build"],
			["side-mode", "side mode"],
			["profile", "openai"],
			["advisor", "advisor(o/gpt-5.6-sol)"],
		]), 120, theme)[2] ?? "";

		expect(statusLine).toContain("plan");
		expect(colors.get("accent")).toContain("plan");
		expect(colors.get("accent")).toContain("build");
		expect(colors.get("accent")).toContain("side mode");
		expect(colors.get("warning")).toContain("⟳ sandbox");
		expect(colors.get("muted")).toContain("openai");
		expect(colors.get("muted")).toContain("advisor(o/gpt-5.6-sol)");
	});

	it("right-aligns the advisor status after other extension statuses", () => {
		const left = "openai · auto-review";
		const advisor = "advisor(o/gpt-5.6-sol)";
		const width = 80;
		const lines = renderFooter(new Map([
			["advisor", advisor],
			["approval-mode", left],
		]), width);

		const statusLine = lines[2] ?? "";
		expect(statusLine.endsWith(advisor)).toBe(true);
		expect(visibleWidth(statusLine)).toBe(width);
		expect(statusLine.slice(0, statusLine.length - advisor.length)).toContain(left);
	});

	it("right-aligns the advisor when it is the only extension status", () => {
		const advisor = "advisor(o/gpt-5.6-sol)";
		const width = 60;
		const statusLine = renderFooter(new Map([["advisor", advisor]]), width)[2] ?? "";

		expect(statusLine).toBe(" ".repeat(width - visibleWidth(advisor)) + advisor);
	});

	it("keeps non-advisor statuses left-aligned", () => {
		const statusLine = renderFooter(new Map([["approval-mode", "openai · auto-review"]]), 80)[2] ?? "";

		expect(statusLine).toBe("openai · auto-review");
	});

	it("measures styled advisor text by visible width", () => {
		const advisor = "advisor(o/gpt-5.6-sol)";
		const styledAdvisor = `\u001b[35m${advisor}\u001b[39m`;
		const width = 80;
		const statusLine = renderFooter(new Map([["advisor", styledAdvisor]]), width)[2] ?? "";

		expect(visibleWidth(statusLine)).toBe(width);
		expect(stripTerminalSequences(statusLine).endsWith(advisor)).toBe(true);
	});

	it("does not exceed a narrow terminal width", () => {
		const width = 12;
		const statusLine = renderFooter(new Map([
			["advisor", "advisor(o/gpt-5.6-sol)"],
			["approval-mode", "auto-review"],
		]), width)[2] ?? "";

		expect(visibleWidth(statusLine)).toBeLessThanOrEqual(width);
	});
});
