import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mutatePiConfigDocument, piConfigPath, readPiConfigDocument } from "./pi-config.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-config-test-"));
	roots.push(root);
	return root;
}

describe("pi-config document", () => {
	it("resolves the path to .pi/pi-config.json", () => {
		expect(piConfigPath("/workspace")).toBe(join("/workspace", ".pi", "pi-config.json"));
	});

	it("returns undefined for a missing document", () => {
		expect(readPiConfigDocument(piConfigPath(project()))).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		const cwd = project();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(piConfigPath(cwd), "{ not json");
		expect(readPiConfigDocument(piConfigPath(cwd))).toBeUndefined();
	});

	it("reads a valid document", () => {
		const cwd = project();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(piConfigPath(cwd), JSON.stringify({
			profile: "research",
			permissions: { mode: "read-only" },
		}));
		expect(readPiConfigDocument(piConfigPath(cwd))).toEqual({
			profile: "research",
			permissions: { mode: "read-only" },
		});
	});

	it("creates the document and .pi directory on first write", () => {
		const cwd = project();
		const document = mutatePiConfigDocument(piConfigPath(cwd), () => ({
			permissions: { mode: "default" },
		}));
		expect(document).toEqual({ permissions: { mode: "default" } });
		expect(JSON.parse(readFileSync(piConfigPath(cwd), "utf-8"))).toEqual({
			permissions: { mode: "default" },
		});
	});

	it("preserves sibling namespaces and unknown keys when mutating", () => {
		const cwd = project();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(piConfigPath(cwd), JSON.stringify({
			profile: "research",
			permissions: { mode: "read-only" },
			custom: 1,
		}));
		const document = mutatePiConfigDocument(piConfigPath(cwd), (doc) => ({
			...doc,
			permissions: { ...(doc.permissions as object), mode: "auto-review" },
		}));
		expect(document).toEqual({
			profile: "research",
			permissions: { mode: "auto-review" },
			custom: 1,
		});
	});
});