import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildGuidelines,
	insertGuidelines,
	stripGuidelines,
	type GuidelineSource,
} from "./sections.ts";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Parity target: the pi build the user actually runs (global install), NOT the
 * repo-pinned devDependency — their renderers can differ (0.84.1 lacks the
 * PowerShell guideline variants that 0.84.3 ships). File-path imports bypass
 * the package exports map. Skipped when the global install is unavailable.
 */
const RUNTIME_PI_PROMPT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
let buildSystemPrompt: ((options: Record<string, unknown>) => string) | undefined;
try {
	({ buildSystemPrompt } = await import(/* @vite-ignore */ RUNTIME_PI_PROMPT));
} catch {
	buildSystemPrompt = undefined;
}

/** The user's real active tool set, mirroring their live prompt. */
const REAL_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"advisor",
	"ask_user",
	"code_review",
	"list_files",
	"github_repo_acquire",
	"github_repo_list",
	"github_repo_remove",
	"subagent",
	"todo",
	"ddg_fetch",
	"ddg_search",
	"worktree_create",
	"worktree_list",
	"worktree_remove",
	"goal",
];

const REAL_OPTIONS: GuidelineSource = {
	selectedTools: REAL_TOOLS,
	promptGuidelines: [
		"Use read to examine files instead of cat or sed.",
		"You can inspect PI_* environment variables for current model and session details.",
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"Use write only for new files or complete rewrites.",
		"Use ask_user only when missing user input materially affects the work.",
		"Use github_repo_acquire before inspecting a remote GitHub repository.",
		"Use subagents only when their final handoff will be substantially smaller.",
		"For non-trivial work with at least three distinct steps, create a todo list before implementation.",
	],
};

/** Extract the guidelines region of a stock pi build. */
function stockGuidelines(built: string): string {
	const start = built.indexOf("Guidelines:");
	const end = built.indexOf("\n\nPi documentation");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return built.slice(start, end);
}

describe.skipIf(!buildSystemPrompt)("parity with the runtime-installed pi", () => {
	it("matches pi's stock guideline rendering byte for byte (golden parity)", () => {
		const built = buildSystemPrompt!({ ...REAL_OPTIONS, cwd: "/tmp/probe" });
		expect(buildGuidelines(REAL_OPTIONS)).toBe(stockGuidelines(built));
	});

	it("matches pi with no contributed guidelines", () => {
		const options: GuidelineSource = { selectedTools: ["read"] };
		const built = buildSystemPrompt!({ ...options, cwd: "/tmp/probe" });
		expect(buildGuidelines(options)).toBe(stockGuidelines(built));
	});

	it("matches pi's conditional file-operations guideline variants", () => {
		const cases: Array<{ tools: string[]; expected?: string }> = [
			{ tools: ["bash"], expected: "- Use bash for file operations like ls, rg, find" },
			{ tools: ["powershell"], expected: "- Use PowerShell for file operations like listing, searching, and finding files" },
			{ tools: ["bash", "powershell"], expected: "- Use bash or PowerShell for file operations like listing, searching, and finding files" },
			{ tools: ["bash", "grep"], expected: undefined },
			{ tools: ["read", "edit"], expected: undefined },
		];
		for (const { tools, expected } of cases) {
			const built = buildSystemPrompt!({ selectedTools: tools, cwd: "/tmp/probe" });
			const rendered = buildGuidelines({ selectedTools: tools });
			expect(rendered).toBe(stockGuidelines(built));
			if (expected === undefined) {
				expect(rendered).not.toContain("file operations like");
			} else {
				expect(rendered).toContain(expected);
			}
		}
	});

	it("renders no tool list (tool discovery rides on payload schemas)", () => {
		const rendered = buildGuidelines(REAL_OPTIONS);
		expect(rendered.startsWith("Guidelines:\n")).toBe(true);
		expect(rendered).not.toContain("Available tools:");
		expect(rendered).not.toContain("In addition to the tools above");
		expect(rendered).not.toContain("- read: ");
	});
});

describe("buildGuidelines (self-contained)", () => {
	it("deduplicates and trims guideline bullets like pi", () => {
		const options: GuidelineSource = {
			selectedTools: ["read"],
			promptGuidelines: [
				"  Use read to examine files instead of cat or sed.  ",
				"Use read to examine files instead of cat or sed.",
				"",
				"   ",
				"Be concise in your responses",
			],
		};
		const rendered = buildGuidelines(options);
		const guidelineLines = rendered.slice("Guidelines:\n".length).split("\n");
		expect(guidelineLines).toEqual([
			"- Use read to examine files instead of cat or sed.",
			"- Be concise in your responses",
			"- Show file paths clearly when working with files",
		]);
	});

	it("always ends with the two always-on guidelines", () => {
		const rendered = buildGuidelines(REAL_OPTIONS);
		expect(rendered.endsWith("- Be concise in your responses\n- Show file paths clearly when working with files")).toBe(true);
	});
});

describe("insertGuidelines", () => {
	const base = "PERSONA.\n\nPi documentation refs.\n\n<project_context>…</project_context>\nCurrent working directory: /tmp/probe\n";
	const guidelines = buildGuidelines(REAL_OPTIONS);

	it("inserts the section before the current working directory line", () => {
		const result = insertGuidelines(base, guidelines);
		const blockIndex = result.indexOf("<tool_guidelines>");
		const cwdIndex = result.indexOf("Current working directory:");
		expect(blockIndex).toBeGreaterThan(-1);
		expect(cwdIndex).toBeGreaterThan(blockIndex);
		expect(result).toContain("</tool_guidelines>\nCurrent working directory: /tmp/probe");
	});

	it("appends at the end when the cwd line is missing", () => {
		const result = insertGuidelines("CUSTOM PROMPT WITHOUT CWD LINE\n", guidelines);
		expect(result.endsWith("</tool_guidelines>\n")).toBe(true);
		expect(result.startsWith("CUSTOM PROMPT WITHOUT CWD LINE\n\n<tool_guidelines>")).toBe(true);
	});

	it("is idempotent under repeated application", () => {
		const once = insertGuidelines(base, guidelines);
		const twice = insertGuidelines(once, guidelines);
		expect(twice).toBe(once);
		expect(once.split("<tool_guidelines>").length - 1).toBe(1);
	});

	it("inserts before the last cwd marker so quoted context cannot hijack placement", () => {
		const tricky = `PERSONA.\ninstructions saying\nCurrent working directory: /quoted/inside/context\nmore text\nCurrent working directory: /tmp/probe\n`;
		const result = insertGuidelines(tricky, guidelines);
		expect(result).toContain("</tool_guidelines>\nCurrent working directory: /tmp/probe");
		expect(result).not.toContain("</tool_guidelines>\nCurrent working directory: /quoted/inside/context");
	});

	it("stripGuidelines removes an injected block entirely", () => {
		const withBlock = insertGuidelines(base, guidelines);
		expect(stripGuidelines(withBlock)).toBe(base);
	});
});

describe("SYSTEM.md contract", () => {
	it("starts with a standalone coding-agent role that does not depend on advisor", () => {
		const systemMd = readFileSync(join(projectRoot, "SYSTEM.md"), "utf-8");
		expect(systemMd.startsWith(
			"You are a coding agent operating inside pi. Your job is to inspect the repository, gather evidence, execute commands, edit files, and verify the result.",
		)).toBe(true);
		expect(systemMd.toLowerCase()).not.toContain("advisor");
	});
});