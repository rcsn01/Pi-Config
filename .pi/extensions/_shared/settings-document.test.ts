import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isRecord,
	mutateSettingsDocument,
	PROJECT_SETTINGS_PATH,
	readSettingsDocument,
	writeSettingsDocument,
} from "./settings-document.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryPath(...parts: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "settings-document-"));
	roots.push(root);
	return join(root, ...parts);
}

describe("settings document", () => {
	it("reads a missing document as empty by default", () => {
		expect(readSettingsDocument(temporaryPath("missing.json"))).toEqual({});
	});

	it("rejects a missing document in strict mode with a Cannot read error", () => {
		const path = temporaryPath("missing.json");
		expect(() => readSettingsDocument(path, { missing: "throw" })).toThrow(`Cannot read ${path}:`);
	});

	it.each(["{", "[]", "null"])("rejects malformed or non-object JSON: %s", (contents) => {
		const path = temporaryPath("settings.json");
		writeFileSync(path, contents);
		expect(() => readSettingsDocument(path)).toThrow(`Cannot read ${path}:`);
	});

	it("creates parents, replaces content, and cleans up temporary files", () => {
		const path = temporaryPath("nested", "settings.json");
		writeSettingsDocument(path, { old: true });
		writeSettingsDocument(path, { next: { value: 1 } });
		expect(readFileSync(path, "utf8")).toBe('{\n  "next": {\n    "value": 1\n  }\n}\n');
		expect(readdirSync(dirname(path))).toEqual(["settings.json"]);
	});

	it("mutates queued documents without losing concurrent changes", async () => {
		const path = temporaryPath("settings.json");
		writeSettingsDocument(path, { preserved: true });
		const [first, second] = await Promise.all([
			mutateSettingsDocument(path, (document) => ({ ...document, first: true })),
			mutateSettingsDocument(path, (document) => ({ ...document, second: true })),
		]);
		expect(first).toEqual({ preserved: true, first: true });
		expect(second).toEqual({ preserved: true, first: true, second: true });
		expect(readSettingsDocument(path)).toEqual({ preserved: true, first: true, second: true });
	});

	it("identifies records only", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
	});

	it("resolves the project settings path", () => {
		expect(PROJECT_SETTINGS_PATH).toBe(resolve(import.meta.dirname, "..", "..", "settings.json"));
	});
});
