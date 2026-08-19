import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSubagentsSettingsStore } from "./settings-store.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function settingsFile(content?: string): string {
	const root = mkdtempSync(join(tmpdir(), "subagent-settings-"));
	roots.push(root);
	const path = join(root, "settings.json");
	if (content !== undefined) writeFileSync(path, content);
	return path;
}

describe("subagents settings store", () => {
	it("returns an empty namespace and document for a missing file", () => {
		const store = createSubagentsSettingsStore(settingsFile());
		expect(store.readDocument()).toEqual({});
		expect(store.readNamespace()).toEqual({});
	});

	it("reads the subagents namespace from the settings document", () => {
		const path = settingsFile(
			'{"compaction":{"threshold":0.1},"subagents":{"defaultModel":"main","maxConcurrency":2}}',
		);
		const store = createSubagentsSettingsStore(path);
		expect(store.readNamespace()).toEqual({ defaultModel: "main", maxConcurrency: 2 });
	});

	it("rejects a non-object subagents namespace", () => {
		const path = settingsFile('{"subagents":[]}');
		const store = createSubagentsSettingsStore(path);
		expect(() => store.readNamespace()).toThrow(/must be a JSON object/);
	});

	it("updates the namespace atomically while preserving unrelated settings keys", async () => {
		const path = settingsFile('{"compaction":{"threshold":0.1},"uiModelSelector":{}}');
		const store = createSubagentsSettingsStore(path);
		const result = await store.updateNamespace((ns) => ({ ...ns, defaultModel: "main", maxConcurrency: 4 }));
		expect(result).toEqual({ defaultModel: "main", maxConcurrency: 4 });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			compaction: { threshold: 0.1 },
			uiModelSelector: {},
			subagents: { defaultModel: "main", maxConcurrency: 4 },
		});
	});

	it("bases an update on a supplied base namespace", async () => {
		const path = settingsFile("{}");
		const store = createSubagentsSettingsStore(path);
		const result = await store.updateNamespace(
			(ns) => ({ ...ns, worker: "openai/test" }),
			{ defaultModel: "main" },
		);
		expect(result).toEqual({ defaultModel: "main", worker: "openai/test" });
		expect(JSON.parse(readFileSync(path, "utf8")).subagents).toEqual({
			defaultModel: "main",
			worker: "openai/test",
		});
	});

	it("writes a full namespace atomically", async () => {
		const path = settingsFile('{"compaction":{}}');
		const store = createSubagentsSettingsStore(path);
		await store.writeNamespace({ maxConcurrency: 8 });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			compaction: {},
			subagents: { maxConcurrency: 8 },
		});
	});

	it("throws on a malformed root document", () => {
		expect(() => createSubagentsSettingsStore(settingsFile("[1,2]")).readDocument())
			.toThrow(/root value must be a JSON object/);
		expect(() => createSubagentsSettingsStore(settingsFile("{")).readDocument())
			.toThrow(/Cannot read/);
	});

});
