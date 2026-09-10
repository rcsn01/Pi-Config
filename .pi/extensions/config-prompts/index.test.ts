import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createSavedPromptsExtension, loadSavedPrompts } from "./index.ts";

describe("saved prompts extension", () => {
	it("loads Markdown prompts in stable order with frontmatter descriptions", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-saved-prompts-"));
		writeFileSync(join(root, "second.md"), "Second prompt body\n", "utf8");
		writeFileSync(join(root, "first.md"), "---\ndescription: First description\n---\nFirst prompt body\n", "utf8");
		writeFileSync(join(root, "ignored.txt"), "ignored", "utf8");
		mkdirSync(join(root, "nested.md"));

		expect(loadSavedPrompts(root)).toEqual([
			{ name: "first", description: "First description", content: "First prompt body" },
			{ name: "second", description: "Second prompt body", content: "Second prompt body\n" },
		]);
	});

	it("registers only prompt-prefixed commands and sends the saved content", async () => {
		const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
		const sendUserMessage = vi.fn();
		const pi: any = {
			registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
			sendUserMessage,
		};

		createSavedPromptsExtension([
			{ name: "explore", description: "Explore", content: "Explore option 1." },
			{ name: "evaluate-plan", description: "Evaluate", content: "Evaluate plan.md." },
		])(pi);

		expect([...commands.keys()]).toEqual(["prompt:explore", "prompt:evaluate-plan"]);
		expect(commands.has("explore")).toBe(false);
		await commands.get("prompt:explore")!.handler("", {});
		expect(sendUserMessage).toHaveBeenCalledWith("Explore option 1.");
	});

	it("registers the checked-in prompts under their namespaced commands", () => {
		const prompts = loadSavedPrompts();
		expect(prompts).toMatchObject([
			{
				name: "evaluate-plan",
				description: "Evaluate plan.md against the code for correctness and over-engineering",
			},
			{
				name: "explore",
				description: "Explore option 1 and finalize a detailed implementation plan",
			},
		]);

		const commandNames: string[] = [];
		createSavedPromptsExtension(prompts)({
			registerCommand: (name: string) => commandNames.push(name),
		} as any);
		expect(commandNames).toEqual(["prompt:evaluate-plan", "prompt:explore"]);
	});
});
