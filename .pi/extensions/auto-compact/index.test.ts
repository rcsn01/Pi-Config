import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	disableNativeCompaction,
	disableNativeCompactionInFiles,
	shouldCompactNow,
	vetoNativeCompaction,
} from "./index.ts";

describe("shouldCompactNow", () => {
	it("returns false when usage is undefined", () => {
		expect(shouldCompactNow(undefined)).toBe(false);
	});

	it("returns false when tokens are unknown (null)", () => {
		expect(shouldCompactNow({ tokens: null, contextWindow: 200_000, percent: null })).toBe(false);
	});

	it("returns false when the context window is not positive", () => {
		expect(shouldCompactNow({ tokens: 100, contextWindow: 0, percent: null })).toBe(false);
		expect(shouldCompactNow({ tokens: 100, contextWindow: -1, percent: null })).toBe(false);
	});

	it("returns false below the threshold", () => {
		expect(shouldCompactNow({ tokens: 159_999, contextWindow: 200_000, percent: 80 })).toBe(false);
	});

	it("returns true at the threshold", () => {
		expect(shouldCompactNow({ tokens: 160_000, contextWindow: 200_000, percent: 80 })).toBe(true);
	});

	it("returns true above the threshold", () => {
		expect(shouldCompactNow({ tokens: 180_000, contextWindow: 200_000, percent: 90 })).toBe(true);
	});

	it("honors a custom threshold", () => {
		expect(shouldCompactNow({ tokens: 50_000, contextWindow: 200_000, percent: 25 }, 0.25)).toBe(true);
		expect(shouldCompactNow({ tokens: 49_999, contextWindow: 200_000, percent: 25 }, 0.25)).toBe(false);
	});
});

describe("vetoNativeCompaction", () => {
	it("cancels native threshold compaction", () => {
		expect(vetoNativeCompaction("threshold")).toEqual({ cancel: true });
	});

	it("cancels native overflow compaction", () => {
		expect(vetoNativeCompaction("overflow")).toEqual({ cancel: true });
	});

	it("lets manual compaction pass", () => {
		expect(vetoNativeCompaction("manual")).toBeUndefined();
	});
});

describe("disableNativeCompaction", () => {
	const root = mkdtempSync(join(tmpdir(), "auto-compact-"));
	const settingsPath = join(root, "settings.json");

	afterEach(() => {
		rmSync(settingsPath, { force: true });
	});

	it("writes enabled: false while preserving other keys", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{
					theme: "dark",
					compaction: { enabled: true, threshold: 0.1, keepRecentTokens: 25_600 },
					extensions: [],
				},
				null,
				2,
			)}\n`,
		);

		expect(disableNativeCompaction(settingsPath)).toBe(true);

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.compaction.enabled).toBe(false);
		expect(settings.compaction.threshold).toBe(0.1);
		expect(settings.compaction.keepRecentTokens).toBe(25_600);
		expect(settings.theme).toBe("dark");
		expect(settings.extensions).toEqual([]);
	});

	it("adds the compaction key when absent", () => {
		writeFileSync(settingsPath, `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);

		expect(disableNativeCompaction(settingsPath)).toBe(true);

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.compaction.enabled).toBe(false);
		expect(settings.theme).toBe("dark");
	});

	it("does not write when already disabled", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify({ compaction: { enabled: false, threshold: 0.1 } }, null, 2)}\n`,
		);
		const before = readFileSync(settingsPath, "utf-8");

		expect(disableNativeCompaction(settingsPath)).toBe(false);
		expect(readFileSync(settingsPath, "utf-8")).toBe(before);
	});

	it("fails silently on a missing file", () => {
		expect(disableNativeCompaction(join(root, "does-not-exist.json"))).toBe(false);
	});

	it("fails silently on unparseable content", () => {
		writeFileSync(settingsPath, "not json {");
		expect(disableNativeCompaction(settingsPath)).toBe(false);
	});
});

describe("disableNativeCompactionInFiles", () => {
	const root = mkdtempSync(join(tmpdir(), "auto-compact-files-"));
	const globalPath = join(root, "global-settings.json");
	const projectPath = join(root, "project-settings.json");

	afterEach(() => {
		rmSync(globalPath, { force: true });
		rmSync(projectPath, { force: true });
	});

	it("writes every file that still has compaction enabled", () => {
		writeFileSync(globalPath, `${JSON.stringify({ compaction: { enabled: true } }, null, 2)}\n`);
		writeFileSync(projectPath, `${JSON.stringify({ compaction: { enabled: true, threshold: 0.1 } }, null, 2)}\n`);

		expect(disableNativeCompactionInFiles([globalPath, projectPath])).toEqual([globalPath, projectPath]);
		expect(JSON.parse(readFileSync(globalPath, "utf-8")).compaction.enabled).toBe(false);
		expect(JSON.parse(readFileSync(projectPath, "utf-8")).compaction.enabled).toBe(false);
		expect(JSON.parse(readFileSync(projectPath, "utf-8")).compaction.threshold).toBe(0.1);
	});

	it("skips already-disabled and unreadable files", () => {
		writeFileSync(globalPath, `${JSON.stringify({ compaction: { enabled: false } }, null, 2)}\n`);

		expect(disableNativeCompactionInFiles([globalPath, projectPath])).toEqual([]);
		expect(JSON.parse(readFileSync(globalPath, "utf-8")).compaction.enabled).toBe(false);
	});
});
