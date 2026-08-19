import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import footerExtension from "./index.ts";

function renderFooter(statuses: ReadonlyMap<string, string>, width: number): string[] {
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
	const theme = { fg: (_color: string, text: string) => text };
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
			["plan", "📋 plan"],
			["other", "other"],
			["approval-mode", "auto-review"],
			["profile", "openai"],
		]), 80)[2] ?? "";

		expect(statusLine).toBe("openai | auto-review | 📋 plan | other");
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
