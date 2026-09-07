import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readDefaultProvider, readPiNativeDefaults, writePiNativeDefaults } from "./pi-defaults.ts";

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

	it("reads the default provider without requiring a model", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
		roots.push(root);
		writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultProvider: "openai-codex" }));

		expect(readDefaultProvider(root)).toBe("openai-codex");
	});

	it("returns undefined when no default provider is configured", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
		roots.push(root);
		writeFileSync(join(root, "settings.json"), JSON.stringify({}));

		expect(readDefaultProvider(root)).toBeUndefined();
	});

	it("writes Pi's global native defaults", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
		roots.push(root);

		await writePiNativeDefaults(root, {
			provider: "openai-codex",
			modelId: "gpt-5.6-luna",
			thinkingLevel: "max",
		});

		expect(SettingsManager.create("/irrelevant/cwd", root).getGlobalSettings()).toMatchObject({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-luna",
			defaultThinkingLevel: "max",
		});
	});

	it("writes defaults without touching the thinking level when absent", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
		roots.push(root);
		writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));

		await writePiNativeDefaults(root, { provider: "openai-codex", modelId: "gpt-5.6-luna" });

		expect(SettingsManager.create("/irrelevant/cwd", root).getGlobalSettings()).toMatchObject({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-luna",
			defaultThinkingLevel: "low",
		});
	});

	it("throws the joined drain-errors message when the write fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
		roots.push(root);
		// A settings.json directory makes the flush write fail.
		mkdirSync(join(root, "settings.json"));

		await expect(writePiNativeDefaults(root, { provider: "openai-codex", modelId: "gpt-5.6-luna", thinkingLevel: "max" }))
			.rejects.toThrow(/:\s/);
	});
});
