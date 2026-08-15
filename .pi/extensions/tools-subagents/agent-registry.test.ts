import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRegistry } from "./agent-registry.ts";
import { agent } from "./test-harness.ts";

const roots: string[] = [];

function agentsDir(): string {
	const root = mkdtempSync(join(tmpdir(), "subagent-registry-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent registry", () => {
	it("discovers Markdown agents and ignores unrelated or nameless files", () => {
		const dir = agentsDir();
		writeFileSync(join(dir, "worker.md"), "---\nname: worker\ndescription: Does work\ntools: read, bash\nmodel: openai/test\n---\nSystem prompt\n");
		writeFileSync(join(dir, "nameless.md"), "---\ndescription: none\n---\nIgnored\n");
		writeFileSync(join(dir, "notes.txt"), "ignored");
		const [worker] = createAgentRegistry(dir).load();
		expect(worker).toEqual({
			name: "worker",
			description: "Does work",
			tools: ["read", "bash"],
			model: "openai/test",
			systemPrompt: "System prompt",
			filePath: join(dir, "worker.md"),
		});
	});

	it("lets pre-initialization registrations override discovered agents", () => {
		const dir = agentsDir();
		writeFileSync(join(dir, "worker.md"), "---\nname: worker\n---\nBundled\n");
		const registry = createAgentRegistry(dir);
		registry.register(agent({ description: "Dynamic" }));
		expect(registry.load().find((candidate) => candidate.name === "worker")?.description).toBe("Dynamic");
	});

	it("preserves post-initialization duplicate and unregister semantics", () => {
		const dir = agentsDir();
		writeFileSync(join(dir, "worker.md"), "---\nname: worker\n---\nBundled\n");
		const registry = createAgentRegistry(dir);
		registry.initialize();
		expect(() => registry.register(agent())).toThrow("Agent already registered: worker");
		registry.register(agent({ name: "custom" }));
		expect(registry.resolve("custom").name).toBe("custom");
		registry.unregister("custom");
		expect(registry.load().some((candidate) => candidate.name === "custom")).toBe(false);
		registry.unregister("worker");
		expect(registry.load().some((candidate) => candidate.name === "worker")).toBe(true);
	});

	it("reports all available names for failed lookup", () => {
		const registry = createAgentRegistry(agentsDir());
		registry.register(agent({ name: "worker" }));
		registry.register(agent({ name: "explorer" }));
		expect(() => registry.resolve("missing")).toThrow("Unknown agent: missing. Available agents: worker, explorer");
	});
});
