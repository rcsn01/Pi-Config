import type { SessionEntry, Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	allocateMeter,
	calculateCapacity,
	calculateContextDiagnostics,
	classifyActiveToolTokens,
	estimateRawCategories,
	formatContextFilesForPrompt,
	formatPercent,
	formatTokenCount,
	reconcileCategories,
	type ContextModelInput,
} from "./context-model.ts";

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
