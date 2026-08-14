import type { SessionEntry, Skill, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	allocateMeter,
	calculateCapacity,
	calculateContextDiagnostics,
	classifyActiveToolTokens,
	collectRawExtensionTools,
	collectRawSystemPromptDetails,
	estimateRawCategories,
	estimateToolTokens,
	formatContextFilesForPrompt,
	formatPercent,
	formatTokenCount,
	reconcileCategories,
	reconcileExtensionTools,
	type ContextDiagnostics,
	type ContextModelInput,
} from "./context-model.ts";
import { ContextDiagnosticsComponent, formatBreakdownValue } from "./index.ts";

const builtin = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } } },
	promptGuidelines: [],
	sourceInfo: { source: "builtin", path: "builtin:read", scope: "temporary", origin: "top-level" },
} as unknown as ToolInfo;
const extension = {
	name: "search",
	description: "Search a service",
	parameters: { type: "object", properties: { query: { type: "string" } } },
	promptGuidelines: ["Use search for current facts"],
	sourceInfo: { source: "extension", path: "/extensions/search.ts", scope: "project", origin: "top-level" },
} as unknown as ToolInfo;
const inactive = {
	...extension,
	name: "inactive",
	description: "Must not count",
} as ToolInfo;

function skill(name: string, disableModelInvocation: boolean): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		disableModelInvocation,
		sourceInfo: { source: "local", path: `/skills/${name}`, scope: "project", origin: "top-level" },
	} as Skill;
}

function messageEntry(content: string): SessionEntry {
	return {
		type: "message",
		id: "message-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content, timestamp: 0 },
	} as SessionEntry;
}

function input(overrides: Partial<ContextModelInput> = {}): ContextModelInput {
	return {
		model: { provider: "test", id: "model", contextWindow: 1_000 },
		usage: { tokens: 400, contextWindow: 1_000, percent: 40 },
		systemPrompt: "Base system prompt",
		contextFiles: [],
		skills: [],
		activeToolNames: ["read", "search"],
		allTools: [builtin, extension, inactive],
		contextEntries: [messageEntry("Conversation message")],
		compaction: { enabled: true, reserveTokens: 100 },
		...overrides,
	};
}

describe("context category accounting", () => {
	it("reconciles category estimates to the authoritative reported total", () => {
		const result = calculateContextDiagnostics(input());
		expect(Object.values(result.categories).reduce((sum, value) => sum + value, 0)).toBe(400);
		expect(result.usedTokens).toBe(400);
		expect(result.usedIsEstimated).toBe(false);
	});

	it("preserves an exact target even when all raw estimates are zero", () => {
		const reconciled = reconcileCategories({
			systemPrompt: 0,
			builtinTools: 0,
			extensionTools: 0,
			contextFiles: 0,
			skills: 0,
			messages: 0,
		}, 17);
		expect(reconciled.systemPrompt).toBe(17);
		expect(Object.values(reconciled).reduce((sum, value) => sum + value, 0)).toBe(17);
	});

	it("does not count manual-only skills in idle skill context", () => {
		const manual = skill("manual", true);
		const result = estimateRawCategories(input({ skills: [manual], systemPrompt: "Base system prompt" }));
		expect(result.skills).toBe(0);
	});

	it("counts only automatically visible skills present in the effective prompt", () => {
		const visible = skill("visible", false);
		const files = [{ path: "/repo/AGENTS.md", content: "Project rules" }];
		const contextText = formatContextFilesForPrompt(files);
		const prompt = `Base${contextText}\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>visible</name>\n    <description>visible description</description>\n    <location>/skills/visible/SKILL.md</location>\n  </skill>\n</available_skills>`;
		const result = estimateRawCategories(input({ contextFiles: files, skills: [visible], systemPrompt: prompt }));
		expect(result.contextFiles).toBeGreaterThan(0);
		expect(result.skills).toBeGreaterThan(0);
	});

	it("classifies built-in and extension tools and excludes inactive tools", () => {
		const active = classifyActiveToolTokens(["read", "search"], [builtin, extension, inactive]);
		expect(active.builtinTools).toBeGreaterThan(0);
		expect(active.extensionTools).toBeGreaterThan(0);
		const withoutInactive = classifyActiveToolTokens(["read", "search"], [builtin, extension]);
		expect(active).toEqual(withoutInactive);
	});

	it("includes active extension tools individually and excludes built-in and inactive tools", () => {
		const details = collectRawExtensionTools(["read", "search"], [builtin, extension, inactive]);
		expect(details).toEqual([{
			name: "search",
			tokens: expect.any(Number),
			sourcePath: "/extensions/search.ts",
		}]);
	});

	it("does not double-count prompt guidelines in tool-schema estimates", () => {
		const withoutGuidelines = { ...extension, promptGuidelines: [] } as ToolInfo;
		const withLongGuidelines = {
			...extension,
			promptGuidelines: ["A very long guideline ".repeat(100)],
		} as ToolInfo;
		expect(estimateToolTokens(withLongGuidelines)).toBe(estimateToolTokens(withoutGuidelines));
	});

	it("attributes and exactly reconciles system prompt sources", () => {
		const customPrompt = "Custom role and behavior ".repeat(20);
		const appended = "Large appended policy ".repeat(80);
		const result = calculateContextDiagnostics(input({
			systemPrompt: `${customPrompt}\n\n- Use search carefully\n\n${appended}\nCurrent working directory: /repo`,
			systemPromptOptions: {
				customPrompt,
				selectedTools: ["search"],
				toolSnippets: { search: "Search current information" },
				promptGuidelines: ["Use search carefully"],
				appendSystemPrompt: appended,
				cwd: "/repo",
			},
		}));
		expect(result.systemPromptDetails.reduce((sum, detail) => sum + detail.tokens, 0))
			.toBe(result.categories.systemPrompt);
		expect(result.systemPromptDetails.map((detail) => detail.label)).toEqual(expect.arrayContaining([
			"Custom system prompt",
			"Appended instructions",
			"Working directory",
		]));
		expect(result.systemPromptDetails.some((detail) => detail.label.startsWith("Tool guideline"))).toBe(false);
		expect(result.systemPromptDetails[0]?.label).toBe("Appended instructions");
		const raw = collectRawSystemPromptDetails(input({
			systemPrompt: "Pi core\n- search: Search current information\n- Use search carefully\nCurrent working directory: /repo",
			systemPromptOptions: {
				selectedTools: ["search"],
				toolSnippets: { search: "Search current information" },
				promptGuidelines: ["Use search carefully"],
				cwd: "/repo",
			},
		}));
		expect(raw.map((detail) => detail.label)).toEqual(expect.arrayContaining([
			"Pi core instructions",
			"Tool summary: search",
			"Tool guideline 1",
		]));
	});

	it("reconciles tool details exactly and orders them largest-first with deterministic ties", () => {
		const alpha = { ...extension, name: "alpha", description: "short" } as ToolInfo;
		const gamma = { ...extension, name: "gamma", description: "short" } as ToolInfo;
		const largest = { ...extension, name: "largest", description: "long ".repeat(100) } as ToolInfo;
		const result = calculateContextDiagnostics(input({
			activeToolNames: ["gamma", "largest", "alpha"],
			allTools: [gamma, largest, alpha],
		}));
		expect(result.extensionTools.reduce((sum, tool) => sum + tool.tokens, 0))
			.toBe(result.categories.extensionTools);
		expect(result.extensionTools[0]?.name).toBe("largest");
		const tied = reconcileExtensionTools([
			{ name: "gamma", tokens: 10, sourcePath: "/gamma.ts" },
			{ name: "alpha", tokens: 10, sourcePath: "/alpha.ts" },
		], 20);
		expect(tied.map((tool) => tool.name)).toEqual(["alpha", "gamma"]);
		const zeroRaw = reconcileExtensionTools([
			{ name: "beta", tokens: 0, sourcePath: "/beta.ts" },
			{ name: "alpha", tokens: 0, sourcePath: "/alpha.ts" },
		], 5);
		expect(zeroRaw.reduce((sum, tool) => sum + tool.tokens, 0)).toBe(5);
	});
});

describe("capacity arithmetic", () => {
	it("caps the compaction reserve at remaining capacity", () => {
		expect(calculateCapacity(1_000, 950, { enabled: true, reserveTokens: 100 })).toEqual({
			compactionReserve: 50,
			freeSpace: 0,
		});
		expect(calculateCapacity(1_000, 600, { enabled: true, reserveTokens: 100 })).toEqual({
			compactionReserve: 100,
			freeSpace: 300,
		});
	});

	it("reports no reserve when auto-compaction is disabled", () => {
		expect(calculateCapacity(1_000, 600, { enabled: false, reserveTokens: 100 })).toEqual({
			compactionReserve: 0,
			freeSpace: 400,
		});
	});

	it("uses an estimated total when post-compaction aggregate usage is unknown", () => {
		const result = calculateContextDiagnostics(input({
			usage: { tokens: null, contextWindow: 1_000, percent: null },
		}));
		expect(result.usedIsEstimated).toBe(true);
		expect(result.usedTokens).toBeGreaterThan(0);
		expect(Object.values(result.categories).reduce((sum, value) => sum + value, 0)).toBe(result.usedTokens);
	});

	it("handles zero and missing model context windows", () => {
		const zero = calculateContextDiagnostics(input({
			model: { provider: "test", id: "zero", contextWindow: 0 },
			usage: undefined,
		}));
		expect(zero.contextWindow).toBe(0);
		expect(zero.percent).toBe(0);

		const missing = calculateContextDiagnostics(input({ model: undefined, usage: undefined }));
		expect(missing.contextWindow).toBe(0);
		expect(missing.modelId).toBe("No active model");
	});
});

describe("display helpers", () => {
	it("formats percentages and human-readable token counts", () => {
		expect(formatPercent(4.25)).toBe("4.3%");
		expect(formatPercent(42.4)).toBe("42%");
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(1_250)).toBe("1.3k");
		expect(formatTokenCount(125_000)).toBe("125k");
		expect(formatTokenCount(1_250_000)).toBe("1.25m");
	});

	it("formats breakdown values as a percentage of the full context window", () => {
		expect(formatBreakdownValue(12_500, 270_000)).toBe("13k (4.6%)");
		expect(formatBreakdownValue(12_500, 0)).toBe("13k (n/a)");
	});

	it("keeps percentage breakdowns within narrow and wide modal layouts", () => {
		const diagnostics: ContextDiagnostics = {
			modelId: "test/model",
			contextWindow: 1_000,
			usedTokens: 400,
			usedIsEstimated: false,
			percent: 40,
			categories: {
				systemPrompt: 100,
				builtinTools: 50,
				extensionTools: 50,
				contextFiles: 25,
				skills: 25,
				messages: 150,
			},
			systemPromptDetails: [{
				label: "Pi core instructions",
				tokens: 100,
				description: "Role and standard guidelines",
			}],
			extensionTools: [{
				name: "search",
				tokens: 50,
				sourcePath: "/extensions/search.ts",
			}],
			freeSpace: 500,
			compactionReserve: 100,
			compactionThreshold: 900,
			compactionEnabled: true,
		};
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const keybindings = {
			matches: (data: string, binding: string) => ({
				up: "tui.select.up",
				down: "tui.select.down",
				enter: "tui.select.confirm",
				escape: "tui.select.cancel",
			}[data] === binding),
		};
		const component = new ContextDiagnosticsComponent(
			diagnostics,
			theme,
			keybindings,
			() => {},
			() => {},
		);

		for (const width of [50, 90]) {
			const lines = component.render(width);
			expect(lines.some((line) => line.includes("System prompt") && line.includes("100 (10%)"))).toBe(true);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}

		const expanded = new ContextDiagnosticsComponent(
			diagnostics,
			theme,
			keybindings,
			() => {},
			() => {},
			() => 30,
		);
		expect(expanded.render(90)).toHaveLength(30);
	});

	it("opens the selected System prompt row and shows attributed sources", () => {
		const customPrompt = "Custom behavior ".repeat(30);
		const appended = "Project policy ".repeat(50);
		const diagnostics = calculateContextDiagnostics(input({
			systemPrompt: `${customPrompt}\n${appended}\nCurrent working directory: /repo`,
			systemPromptOptions: {
				customPrompt,
				selectedTools: ["search"],
				toolSnippets: { search: "Search a service" },
				promptGuidelines: ["Use search for current facts"],
				appendSystemPrompt: appended,
				cwd: "/repo",
			},
		}));
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const keybindings = {
			matches: (data: string, binding: string) => ({
				u: "tui.select.up",
				e: "tui.select.confirm",
				x: "tui.select.cancel",
			}[data] === binding),
		};
		let rerenders = 0;
		const component = new ContextDiagnosticsComponent(
			diagnostics,
			theme,
			keybindings,
			() => {},
			() => rerenders++,
		);
		component.handleInput("u");
		component.handleInput("u");
		component.handleInput("e");
		expect(rerenders).toBe(3);
		const lines = component.render(100);
		expect(lines.some((line) => line.includes("System Prompt"))).toBe(true);
		expect(lines.some((line) => line.includes("Appended instructions"))).toBe(true);
		expect(lines.some((line) => line.includes("Custom system prompt"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
		component.handleInput("x");
		expect(component.render(80).some((line) => line.includes("Context Usage"))).toBe(true);
	});

	it("supports extension-tool drill-down, back navigation, closing, and rerender requests", () => {
		const tools = Array.from({ length: 10 }, (_, index) => ({
			...extension,
			name: `tool-${String(index).padStart(2, "0")}-${"very-long-name-".repeat(4)}`,
			description: `description ${"x".repeat(index * 10)}`,
			sourceInfo: {
				...extension.sourceInfo,
				path: `/very/long/path/${"nested/".repeat(8)}tool-${index}.ts`,
			},
		})) as ToolInfo[];
		const diagnostics = calculateContextDiagnostics(input({
			model: { provider: "test", id: "unknown-window", contextWindow: 0 },
			usage: { tokens: 400, contextWindow: 0, percent: 0 },
			activeToolNames: tools.map((tool) => tool.name),
			allTools: tools,
		}));
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const keybindings = {
			matches: (data: string, binding: string) => ({
				u: "tui.select.up",
				d: "tui.select.down",
				e: "tui.select.confirm",
				x: "tui.select.cancel",
			}[data] === binding),
		};
		let closes = 0;
		let rerenders = 0;
		const component = new ContextDiagnosticsComponent(
			diagnostics,
			theme,
			keybindings,
			() => closes++,
			() => rerenders++,
		);

		expect(component.render(80).some((line) => line.includes("Extension tools"))).toBe(true);
		component.handleInput("e");
		expect(rerenders).toBe(1);
		expect(component.render(100).some((line) => line.includes("Extension Tools"))).toBe(true);
		expect(component.render(100).some((line) => line.includes("n/a"))).toBe(true);
		expect(component.render(100).some((line) => line.includes("tool-09") && line.includes("/very/long/path"))).toBe(true);
		for (let index = 0; index < 9; index++) component.handleInput("d");
		expect(rerenders).toBe(10);
		expect(component.render(80).some((line) => line.includes("of 10"))).toBe(true);

		for (const width of [32, 100]) {
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}

		component.handleInput("x");
		expect(rerenders).toBe(11);
		expect(component.render(80).some((line) => line.includes("Context Usage"))).toBe(true);
		expect(closes).toBe(0);
		component.handleInput("x");
		expect(closes).toBe(1);

		const closeWithQ = new ContextDiagnosticsComponent(
			diagnostics,
			theme,
			keybindings,
			() => closes++,
			() => rerenders++,
		);
		closeWithQ.handleInput("q");
		expect(closes).toBe(2);
		const closeDetailWithQ = new ContextDiagnosticsComponent(
			diagnostics,
			theme,
			keybindings,
			() => closes++,
			() => rerenders++,
		);
		closeDetailWithQ.handleInput("e");
		closeDetailWithQ.handleInput("q");
		expect(closes).toBe(3);
	});

	it("allocates narrow and wide meters without exceeding 100 cells", () => {
		const diagnostics = { contextWindow: 1_000, usedTokens: 400, freeSpace: 500, compactionReserve: 100 };
		for (const cells of [17, 100, 500]) {
			const meter = allocateMeter(diagnostics, cells);
			expect(meter.cells).toBeLessThanOrEqual(100);
			expect(meter.used + meter.free + meter.reserve).toBe(meter.cells);
		}
		expect(allocateMeter(diagnostics, 100)).toEqual({ cells: 100, used: 40, free: 50, reserve: 10 });
	});
});
