import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadGuardianSettings,
	parseGuardianSettings,
	saveGuardianSettings,
} from "./guardian-settings.ts";

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("guardian settings", () => {
	it("treats a missing guardian namespace as the guardian.md fallback", () => {
		expect(parseGuardianSettings({ other: true })).toBeUndefined();
	});

	it("parses a complete model selection", () => {
		expect(parseGuardianSettings({
			guardian: {
				provider: "anthropic",
				modelId: "claude-sonnet",
				thinkingLevel: "high",
				contextWindow: 256_000,
			},
		})).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet",
			thinkingLevel: "high",
			contextWindow: 256_000,
		});
	});

	it("rejects malformed guardian values", () => {
		expect(() => parseGuardianSettings({ guardian: [] })).toThrow(/guardian must be a JSON object/);
		expect(() => parseGuardianSettings({ guardian: { provider: "", modelId: "x", thinkingLevel: "high", contextWindow: 1 } })).toThrow(/provider/);
		expect(() => parseGuardianSettings({ guardian: { provider: "x", modelId: "", thinkingLevel: "high", contextWindow: 1 } })).toThrow(/modelId/);
		expect(() => parseGuardianSettings({ guardian: { provider: "x", modelId: "y", thinkingLevel: "turbo", contextWindow: 1 } })).toThrow(/thinkingLevel/);
		expect(() => parseGuardianSettings({ guardian: { provider: "x", modelId: "y", thinkingLevel: "high", contextWindow: 0 } })).toThrow(/contextWindow/);
	});

	it("atomically updates only the guardian namespace", async () => {
		const root = mkdtempSync(join(tmpdir(), "guardian-settings-"));
		roots.push(root);
		const path = join(root, "profile.json");
		writeFileSync(path, JSON.stringify({ keep: { nested: true }, guardian: { stale: true } }));

		await saveGuardianSettings(path, {
			model: { provider: "openai", id: "guardian", contextWindow: 128_000 } as any,
			thinkingLevel: "medium",
			contextWindow: 128_000,
		});

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			keep: { nested: true },
			guardian: {
				provider: "openai",
				modelId: "guardian",
				thinkingLevel: "medium",
				contextWindow: 128_000,
			},
		});
		expect(loadGuardianSettings(path)?.modelId).toBe("guardian");
	});
});
