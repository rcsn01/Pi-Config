import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

type BeforeAgentStartHandler = (event: {
	systemPrompt: string;
	systemPromptOptions: {
		customPrompt?: string;
		selectedTools?: string[];
		toolSnippets?: Record<string, string>;
		promptGuidelines?: string[];
	};
}) => { systemPrompt: string } | undefined | void;

function createPi() {
	const handlers = new Map<string, BeforeAgentStartHandler[]>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	return {
		handlers,
		commands,
		on: (event: string, handler: BeforeAgentStartHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, definition: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, definition);
		},
	};
}

const BASE_PROMPT =
	"You are an executor coding agent.\n\nPi documentation refs.\nCurrent working directory: /tmp/probe\n";

const OPTIONS = {
	customPrompt: "You are an executor coding agent.",
	selectedTools: ["read", "bash"],
	toolSnippets: {
		read: "Read file contents",
		bash: "Execute bash commands (ls, grep, find, etc.)",
	},
	promptGuidelines: ["Use read to examine files instead of cat or sed."],
};

function loadHandler() {
	const pi = createPi();
	extension(pi as unknown as ExtensionAPI);
	const handlers = pi.handlers.get("before_agent_start");
	expect(handlers).toBeDefined();
	return handlers![0];
}

describe("before_agent_start handler", () => {
	it("injects only the guidelines section when a custom prompt replaced the default build", () => {
		const handler = loadHandler();
		const result = handler({ systemPrompt: BASE_PROMPT, systemPromptOptions: OPTIONS });
		expect(result).toBeDefined();
		expect(result!.systemPrompt).toContain("<tool_guidelines>\nGuidelines:");
		expect(result!.systemPrompt).toContain("- Use read to examine files instead of cat or sed.");
		expect(result!.systemPrompt).toContain("- Use bash for file operations like ls, rg, find");
		expect(result!.systemPrompt).toContain("</tool_guidelines>\nCurrent working directory: /tmp/probe");
		expect(result!.systemPrompt.startsWith(BASE_PROMPT.slice(0, 30))).toBe(true);
	});

	it("injects no tool list (tool discovery rides on payload schemas)", () => {
		const handler = loadHandler();
		const result = handler({ systemPrompt: BASE_PROMPT, systemPromptOptions: OPTIONS });
		expect(result!.systemPrompt).not.toContain("Available tools:");
		expect(result!.systemPrompt).not.toContain("- read: Read file contents");
	});

	it("does nothing when no custom prompt is set (pi already rendered the guidelines)", () => {
		const handler = loadHandler();
		const result = handler({
			systemPrompt: BASE_PROMPT,
			systemPromptOptions: { ...OPTIONS, customPrompt: undefined },
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined when the prompt is already up to date (double handler run)", () => {
		const handler = loadHandler();
		const first = handler({ systemPrompt: BASE_PROMPT, systemPromptOptions: OPTIONS });
		expect(first).toBeDefined();
		const second = handler({ systemPrompt: first!.systemPrompt, systemPromptOptions: OPTIONS });
		expect(second).toBeUndefined();
	});
});

describe("system-prompt command", () => {
	it("writes the current system prompt to a temp file and notifies", async () => {
		const pi = createPi();
		extension(pi as unknown as ExtensionAPI);
		const command = pi.commands.get("system-prompt");
		expect(command).toBeDefined();

		const marker = `system-prompt-test-${Date.now()}`;
		const notify = vi.fn();
		await command!.handler("", {
			getSystemPrompt: () => `PROMPT ${marker}`,
			hasUI: true,
			ui: { notify },
		});

		const written = readdirSync(tmpdir())
			.filter((name) => name.startsWith("pi-system-prompt-"))
			.map((name) => join(tmpdir(), name))
			.filter((path) => readFileSync(path, "utf-8").includes(marker));
		expect(written.length).toBeGreaterThan(0);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining(written[0]), "info");
		rmSync(written[0]);
	});
});