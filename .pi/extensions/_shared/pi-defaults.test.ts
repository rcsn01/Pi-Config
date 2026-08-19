import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPiNativeDefaults } from "./pi-defaults.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi native defaults", () => {
	it("reads only the global provider, model, and thinking settings", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
		roots.push(root);
		writeFileSync(join(root, "settings.json"), JSON.stringify({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-luna",
			defaultThinkingLevel: "max",
			uiModelSelector: { profiles: { normal: "project-only" } },
		}, null, 2));

		expect(readPiNativeDefaults(root)).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.6-luna",
			thinkingLevel: "max",
		});
	});

	it("rejects native settings without a configured provider or model", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
		roots.push(root);
		writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultThinkingLevel: "max" }));

		expect(() => readPiNativeDefaults(root)).toThrow(/defaultProvider and defaultModel/);
	});
});
