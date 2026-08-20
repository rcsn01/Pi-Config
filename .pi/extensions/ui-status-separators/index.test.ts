import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import footerExtension, { ensureThinkingCycleBinding } from "./index.ts";

let testAgentDir = "";
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
	testAgentDir = mkdtempSync(join(tmpdir(), "ui-status-separators-agent-"));
	process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

afterAll(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	rmSync(testAgentDir, { recursive: true, force: true });
});

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

describe("keybinding provisioning", () => {
	it("creates the config directory and required binding when missing", () => {
		const root = mkdtempSync(join(tmpdir(), "ui-status-separators-config-"));
		const configPath = join(root, "nested", "keybindings.json");

		try {
			ensureThinkingCycleBinding(configPath);

			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
				"app.thinking.cycle": [],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves unrelated keybindings while adding the required binding", () => {
		const root = mkdtempSync(join(tmpdir(), "ui-status-separators-config-"));
		const configPath = join(root, "keybindings.json");
		writeFileSync(configPath, JSON.stringify({ "app.model.select": "ctrl+l" }, null, 2) + "\n");

		try {
			ensureThinkingCycleBinding(configPath);

			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
				"app.model.select": "ctrl+l",
				"app.thinking.cycle": [],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("replaces a conflicting thinking-cycle binding", () => {
		const root = mkdtempSync(join(tmpdir(), "ui-status-separators-config-"));
		const configPath = join(root, "keybindings.json");
		writeFileSync(configPath, JSON.stringify({
			"app.thinking.cycle": ["shift+tab"],
			"app.model.select": "ctrl+l",
		}, null, 2) + "\n");

		try {
			ensureThinkingCycleBinding(configPath);

			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
				"app.thinking.cycle": [],
				"app.model.select": "ctrl+l",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not rewrite an already-correct config", () => {
		const root = mkdtempSync(join(tmpdir(), "ui-status-separators-config-"));
		const configPath = join(root, "keybindings.json");
		const original = '{\n  "app.thinking.cycle": []\n}\n';
		writeFileSync(configPath, original);

		try {
			ensureThinkingCycleBinding(configPath);
			ensureThinkingCycleBinding(configPath);

			expect(readFileSync(configPath, "utf8")).toBe(original);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves malformed JSON unchanged and warns", () => {
		const root = mkdtempSync(join(tmpdir(), "ui-status-separators-config-"));
		const configPath = join(root, "keybindings.json");
		const malformed = "{ not valid json";
		writeFileSync(configPath, malformed);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			ensureThinkingCycleBinding(configPath);

			expect(readFileSync(configPath, "utf8")).toBe(malformed);
			expect(warning).toHaveBeenCalledOnce();
		} finally {
			warning.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses Pi's configured agent directory when the extension loads", () => {
		const configPath = join(testAgentDir, "keybindings.json");
		rmSync(configPath, { force: true });

		footerExtension({ on: vi.fn() } as any);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			"app.thinking.cycle": [],
		});
	});
});

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
