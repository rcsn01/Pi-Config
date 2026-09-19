import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isProjectTrustedContext,
	mutateProjectNamespace,
	piConfigPath,
	readProjectDocument,
} from "./pi-config.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-config-test-"));
	roots.push(root);
	return root;
}

function writeDocument(cwd: string, contents: string): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(piConfigPath(cwd), contents);
}

describe("pi-config document", () => {
	it("resolves the path to .pi/pi-config.json", () => {
		expect(piConfigPath("/workspace")).toBe(join("/workspace", ".pi", "pi-config.json"));
	});

	it("returns undefined for an untrusted project even when a valid document exists", () => {
		const cwd = project();
		writeDocument(cwd, JSON.stringify({ permissions: { mode: "read-only" } }));
		expect(readProjectDocument(cwd, false)).toBeUndefined();
	});

	it("returns undefined for missing, malformed, and empty documents", () => {
		const cwd = project();
		expect(readProjectDocument(cwd, true)).toBeUndefined();

		writeDocument(cwd, "{ not json");
		expect(readProjectDocument(cwd, true)).toBeUndefined();

		writeDocument(cwd, "{}");
		expect(readProjectDocument(cwd, true)).toBeUndefined();
	});

	it("reads a valid document", () => {
		const cwd = project();
		writeDocument(cwd, JSON.stringify({
			profile: "research",
			permissions: { mode: "read-only" },
		}));
		expect(readProjectDocument(cwd, true)).toEqual({
			profile: "research",
			permissions: { mode: "read-only" },
		});
	});

	it("creates the document and .pi directory on first write", () => {
		const cwd = project();
		const namespace = mutateProjectNamespace(cwd, true, "permissions", () => ({
			mode: "default",
		}));
		expect(namespace).toEqual({ mode: "default" });
		expect(JSON.parse(readFileSync(piConfigPath(cwd), "utf-8"))).toEqual({
			permissions: { mode: "default" },
		});
	});

	it("preserves sibling namespaces and unknown keys when mutating", () => {
		const cwd = project();
		writeDocument(cwd, JSON.stringify({
			profile: "research",
			permissions: { mode: "read-only" },
			custom: 1,
		}));
		const namespace = mutateProjectNamespace(cwd, true, "permissions", (current) => ({
			...current,
			mode: "auto-review",
		}));
		expect(namespace).toEqual({ mode: "auto-review" });
		expect(JSON.parse(readFileSync(piConfigPath(cwd), "utf-8"))).toEqual({
			profile: "research",
			permissions: { mode: "auto-review" },
			custom: 1,
		});
	});

	it("passes the prior namespace to the callback (undefined when absent) and merges within it", () => {
		const cwd = project();
		writeDocument(cwd, JSON.stringify({ execPolicy: { rules: [1], other: "kept" } }));

		const observed: Array<Record<string, unknown> | undefined> = [];
		mutateProjectNamespace(cwd, true, "execPolicy", (current) => {
			observed.push(current);
			return { ...current, rules: [1, 2] };
		});
		mutateProjectNamespace(cwd, true, "profile", (current) => {
			observed.push(current);
			return { name: "research" };
		});

		expect(observed).toEqual([{ rules: [1], other: "kept" }, undefined]);
		expect(JSON.parse(readFileSync(piConfigPath(cwd), "utf-8"))).toEqual({
			execPolicy: { rules: [1, 2], other: "kept" },
			profile: { name: "research" },
		});
	});

	it("returns undefined for an untrusted project and leaves the file untouched", () => {
		const absent = project();
		expect(mutateProjectNamespace(absent, false, "permissions", () => ({ mode: "default" })))
			.toBeUndefined();
		expect(existsSync(piConfigPath(absent))).toBe(false);

		const existing = project();
		writeDocument(existing, JSON.stringify({ profile: "research" }));
		expect(mutateProjectNamespace(existing, false, "permissions", () => ({ mode: "default" })))
			.toBeUndefined();
		expect(JSON.parse(readFileSync(piConfigPath(existing), "utf-8"))).toEqual({ profile: "research" });
	});

	it("removes the namespace when the callback returns undefined, preserving siblings", () => {
		const cwd = project();
		writeDocument(cwd, JSON.stringify({
			profile: "research",
			permissions: { mode: "read-only" },
			custom: 1,
		}));

		expect(mutateProjectNamespace(cwd, true, "permissions", () => undefined)).toBeUndefined();
		expect(JSON.parse(readFileSync(piConfigPath(cwd), "utf-8"))).toEqual({
			profile: "research",
			custom: 1,
		});
	});

	it("treats absent, non-function, and false probes as untrusted", () => {
		expect(isProjectTrustedContext({})).toBe(false);
		expect(isProjectTrustedContext({ isProjectTrusted: "nope" as unknown as () => boolean })).toBe(false);
		expect(isProjectTrustedContext({ isProjectTrusted: () => false })).toBe(false);
		expect(isProjectTrustedContext({ isProjectTrusted: () => true })).toBe(true);
	});
});