import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseExtensionCatalog } from "./catalog.ts";
import { createExtensionToggleSession } from "./extension-toggle.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("extension toggle discovery", () => {
	it("lists valid enabled and disabled Extensions in name order with metadata and protection", () => {
		const root = repository();
		writeExtension(root, "extensions", "zeta");
		writeExtension(root, "extensions", "config-feature-flag");
		writeExtension(root, "extensions-disabled", "alpha");
		fs.mkdirSync(path.join(root, ".pi", "extensions", "ignored"), { recursive: true });

		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				alpha: entry("Alpha", "test", false),
				zeta: entry("Zeta", "test", true),
				"config-feature-flag": entry("Feature flags", "core", true),
			},
		});
		const session = createExtensionToggleSession(root, catalog);

		expect(session.extensions.map(({ name, enabled }) => [name, enabled])).toEqual([
			["alpha", false],
			["config-feature-flag", true],
			["zeta", true],
		]);
		expect(session.extensions.find(({ name }) => name === "alpha")?.metadata).toEqual(catalog.extensions.alpha);
		expect(session.extensions.find(({ name }) => name === "config-feature-flag")?.protected).toBe(true);
		expect(session.extensions.some(({ name }) => name === "ignored")).toBe(false);
	});

	it("handles missing Extension directories", () => {
		const root = repository();
		const catalog = parseExtensionCatalog({ version: 1, extensions: {} });

		expect(createExtensionToggleSession(root, catalog).extensions).toEqual([]);
	});

	it("rejects names outside the snapshot without changing directories", () => {
		const root = repository();
		writeExtension(root, "extensions", "alpha");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { alpha: entry("Alpha", "test", false) },
		}));

		const result = session.apply(new Set(["ghost"]));

		expect(result).toMatchObject({ status: "rejected", outcomes: [], enabled: ["alpha"] });
		expect(result.issues).toEqual(['Unknown extension "ghost" was requested.']);
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "alpha", "index.ts"))).toBe(true);
	});

	it("rejects disabling an enabled protected Extension before moving anything", () => {
		const root = repository();
		writeExtension(root, "extensions", "config-feature-flag");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { "config-feature-flag": entry("Feature flags", "core", true) },
		}));

		const result = session.apply(new Set());

		expect(result).toMatchObject({ status: "rejected", outcomes: [], enabled: ["config-feature-flag"] });
		expect(result.issues).toContain('"config-feature-flag" is protected and cannot be disabled.');
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "config-feature-flag", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "config-feature-flag"))).toBe(false);
	});

	it("rejects missing requirements and conflicts before moving anything", () => {
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				core: entry("Core", "core", true),
				worker: { ...entry("Worker", "test", false), requires: ["core"], conflicts: ["loop"] },
				loop: entry("Loop", "test", false),
			},
		});
		const missingRoot = repository();
		writeExtension(missingRoot, "extensions-disabled", "worker");
		const missingSession = createExtensionToggleSession(missingRoot, catalog);
		const missingResult = missingSession.apply(new Set(["worker"]));
		expect(missingResult).toMatchObject({ status: "rejected", outcomes: [] });
		expect(missingResult.issues).toContain('"worker" requires "core" to be enabled.');
		expect(fs.existsSync(path.join(missingRoot, ".pi", "extensions-disabled", "worker", "index.ts"))).toBe(true);

		const conflictRoot = repository();
		writeExtension(conflictRoot, "extensions", "core");
		writeExtension(conflictRoot, "extensions-disabled", "worker");
		writeExtension(conflictRoot, "extensions-disabled", "loop");
		const conflictSession = createExtensionToggleSession(conflictRoot, catalog);
		const conflictResult = conflictSession.apply(new Set(["core", "worker", "loop"]));
		expect(conflictResult).toMatchObject({ status: "rejected", outcomes: [] });
		expect(conflictResult.issues).toContain('"worker" conflicts with "loop".');
		expect(fs.existsSync(path.join(conflictRoot, ".pi", "extensions-disabled", "worker", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(conflictRoot, ".pi", "extensions-disabled", "loop", "index.ts"))).toBe(true);
	});

	it("disables dependents before their requirements for a valid closed batch", () => {
		const root = repository();
		writeExtension(root, "extensions", "core");
		writeExtension(root, "extensions", "worker");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				core: entry("Core", "core", true),
				worker: { ...entry("Worker", "test", false), requires: ["core"] },
			},
		});
		const session = createExtensionToggleSession(root, catalog);

		const result = session.apply(new Set());

		expect(result).toMatchObject({
			status: "applied",
			enabled: [],
			outcomes: [
				{ name: "worker", direction: "disable", status: "moved" },
				{ name: "core", direction: "disable", status: "moved" },
			],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "worker", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "core", "index.ts"))).toBe(true);
	});

	it("blocks removing a requirement when its dependent remains enabled", () => {
		const root = repository();
		writeExtension(root, "extensions", "core");
		writeExtension(root, "extensions", "worker");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				core: entry("Core", "core", true),
				worker: { ...entry("Worker", "test", false), requires: ["core"] },
			},
		});
		const session = createExtensionToggleSession(root, catalog);

		const result = session.apply(new Set(["worker"]));

		expect(result).toMatchObject({ status: "rejected", outcomes: [], enabled: ["core", "worker"] });
		expect(result.issues).toEqual([
			'Cannot disable "core": enabled extension "worker" depends on it. Disable "worker" first.',
		]);
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "core", "index.ts"))).toBe(true);
	});

	it("uses Extension names as a stable tie-breaker for unrelated moves", () => {
		const root = repository();
		writeExtension(root, "extensions", "zeta");
		writeExtension(root, "extensions", "alpha");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({ version: 1, extensions: {} }));

		const result = session.apply(new Set());

		expect(result).toMatchObject({
			status: "applied",
			outcomes: [
				{ name: "alpha", direction: "disable", status: "moved" },
				{ name: "zeta", direction: "disable", status: "moved" },
			],
		});
	});

	it("enables requirements before their dependents", () => {
		const root = repository();
		writeExtension(root, "extensions-disabled", "core");
		writeExtension(root, "extensions-disabled", "worker");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				core: entry("Core", "core", true),
				worker: { ...entry("Worker", "test", false), requires: ["core"] },
			},
		});
		const session = createExtensionToggleSession(root, catalog);

		const result = session.apply(new Set(["core", "worker"]));

		expect(result).toMatchObject({
			status: "applied",
			enabled: ["core", "worker"],
			outcomes: [
				{ name: "core", direction: "enable", status: "moved" },
				{ name: "worker", direction: "enable", status: "moved" },
			],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "core", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "worker", "index.ts"))).toBe(true);
	});

	it.each([true, false])("replaces conflicting Extensions in safe order when old declares conflict=%s", (oldDeclaresConflict) => {
		const root = repository();
		writeExtension(root, "extensions", "old");
		writeExtension(root, "extensions-disabled", "replacement");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				old: { ...entry("Old", "test", true), conflicts: oldDeclaresConflict ? ["replacement"] : [] },
				replacement: { ...entry("Replacement", "test", false), conflicts: oldDeclaresConflict ? [] : ["old"] },
			},
		});
		const session = createExtensionToggleSession(root, catalog);

		const result = session.apply(new Set(["replacement"]));

		expect(result).toMatchObject({
			status: "applied",
			enabled: ["replacement"],
			outcomes: [
				{ name: "old", direction: "disable", status: "moved" },
				{ name: "replacement", direction: "enable", status: "moved" },
			],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "old", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "replacement", "index.ts"))).toBe(true);
	});

	it("skips a conflicting enable when the old Extension cannot be removed", () => {
		const root = repository();
		writeExtension(root, "extensions", "old");
		writeExtension(root, "extensions-disabled", "replacement");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				old: { ...entry("Old", "test", true), conflicts: ["replacement"] },
				replacement: entry("Replacement", "test", false),
			},
		});
		const session = createExtensionToggleSession(root, catalog);
		fs.mkdirSync(path.join(root, ".pi", "extensions-disabled", "old"), { recursive: true });

		const result = session.apply(new Set(["replacement"]));

		expect(result).toMatchObject({
			status: "failed",
			enabled: ["old"],
			outcomes: [
				{ name: "old", direction: "disable", status: "failed" },
				{ name: "replacement", direction: "enable", status: "skipped" },
			],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "old", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "replacement", "index.ts"))).toBe(true);
	});

	it("repairs a pre-existing conflict while applying unrelated requested work", () => {
		const root = repository();
		writeExtension(root, "extensions", "goal");
		writeExtension(root, "extensions", "plan");
		writeExtension(root, "extensions-disabled", "unrelated");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				goal: { ...entry("Goal", "test", false), conflicts: ["plan"] },
				plan: { ...entry("Plan", "test", false), conflicts: ["goal"] },
				unrelated: entry("Unrelated", "test", false),
			},
		});
		const session = createExtensionToggleSession(root, catalog);

		const result = session.apply(new Set(["plan", "unrelated"]));

		expect(result).toMatchObject({
			status: "applied",
			enabled: ["plan", "unrelated"],
			outcomes: [
				{ name: "goal", direction: "disable", status: "moved" },
				{ name: "unrelated", direction: "enable", status: "moved" },
			],
		});
	});

	it("skips a dependent enable after its prerequisite fails but applies unrelated work", () => {
		const root = repository();
		writeExtension(root, "extensions-disabled", "core");
		writeExtension(root, "extensions-disabled", "worker");
		writeExtension(root, "extensions-disabled", "unrelated");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				core: entry("Core", "core", true),
				worker: { ...entry("Worker", "test", false), requires: ["core"] },
				unrelated: entry("Unrelated", "test", false),
			},
		});
		const session = createExtensionToggleSession(root, catalog);
		fs.mkdirSync(path.join(root, ".pi", "extensions", "core"), { recursive: true });

		const result = session.apply(new Set(["core", "worker", "unrelated"]));

		expect(result).toMatchObject({
			status: "partial",
			enabled: ["unrelated"],
			outcomes: [
				{ name: "core", direction: "enable", status: "failed" },
				{ name: "unrelated", direction: "enable", status: "moved" },
				{ name: "worker", direction: "enable", status: "skipped" },
			],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "unrelated", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "worker", "index.ts"))).toBe(true);
	});

	it("skips a requirement disable after its dependent cannot be moved", () => {
		const root = repository();
		writeExtension(root, "extensions", "core");
		writeExtension(root, "extensions", "worker");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				core: entry("Core", "core", true),
				worker: { ...entry("Worker", "test", false), requires: ["core"] },
			},
		});
		const session = createExtensionToggleSession(root, catalog);
		fs.mkdirSync(path.join(root, ".pi", "extensions-disabled", "worker"), { recursive: true });

		const result = session.apply(new Set());

		expect(result).toMatchObject({
			status: "failed",
			enabled: ["core", "worker"],
			outcomes: [
				{ name: "worker", direction: "disable", status: "failed" },
				{ name: "core", direction: "disable", status: "skipped" },
			],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "core", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "worker", "index.ts"))).toBe(true);
	});

	it("treats an Extension already moved to the requested root while the picker was open as unchanged", () => {
		const root = repository();
		writeExtension(root, "extensions", "alpha");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { alpha: entry("Alpha", "test", false) },
		}));
		fs.mkdirSync(path.join(root, ".pi", "extensions-disabled"), { recursive: true });
		fs.renameSync(
			path.join(root, ".pi", "extensions", "alpha"),
			path.join(root, ".pi", "extensions-disabled", "alpha"),
		);

		const result = session.apply(new Set());

		expect(result).toMatchObject({ status: "unchanged", enabled: [], outcomes: [] });
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "alpha", "index.ts"))).toBe(true);
	});

	it("reports a snapshotted disabled Extension that disappears before apply", () => {
		const root = repository();
		writeExtension(root, "extensions-disabled", "alpha");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { alpha: entry("Alpha", "test", false) },
		}));
		fs.rmSync(path.join(root, ".pi", "extensions-disabled", "alpha"), { recursive: true });

		const result = session.apply(new Set());

		expect(result).toMatchObject({
			status: "failed",
			outcomes: [{ name: "alpha", direction: "disable", status: "failed" }],
		});
	});

	it("reports a requested Extension missing from both roots", () => {
		const root = repository();
		writeExtension(root, "extensions", "alpha");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { alpha: entry("Alpha", "test", false) },
		}));
		fs.rmSync(path.join(root, ".pi", "extensions", "alpha"), { recursive: true });

		const result = session.apply(new Set());

		expect(result).toMatchObject({
			status: "failed",
			enabled: [],
			outcomes: [{ name: "alpha", direction: "disable", status: "failed" }],
		});
	});

	it("does not replace an empty destination directory", () => {
		const root = repository();
		writeExtension(root, "extensions", "alpha");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { alpha: entry("Alpha", "test", false) },
		}));
		const destination = path.join(root, ".pi", "extensions-disabled", "alpha");
		fs.mkdirSync(destination, { recursive: true });

		const result = session.apply(new Set());

		expect(result).toMatchObject({
			status: "failed",
			outcomes: [{ name: "alpha", direction: "disable", status: "failed" }],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "alpha", "index.ts"))).toBe(true);
		expect(fs.existsSync(destination)).toBe(true);
		expect(fs.readdirSync(destination)).toEqual([]);
	});

	it("rejects an Extension found in both roots", () => {
		const root = repository();
		writeExtension(root, "extensions", "alpha");
		writeExtension(root, "extensions-disabled", "alpha");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { alpha: entry("Alpha", "test", false) },
		}));

		const result = session.apply(new Set());

		expect(result).toMatchObject({
			status: "failed",
			enabled: ["alpha"],
			outcomes: [{ name: "alpha", direction: "disable", status: "failed" }],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "alpha", "index.ts"))).toBe(true);
	});

	it("leaves Extensions discovered after the session outside its mutations", () => {
		const root = repository();
		writeExtension(root, "extensions", "known");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { known: entry("Known", "test", false) },
		}));
		writeExtension(root, "extensions", "new-enabled");
		writeExtension(root, "extensions-disabled", "new-disabled");

		const result = session.apply(new Set());

		expect(result).toMatchObject({ status: "applied", enabled: ["new-enabled"] });
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "known", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "new-enabled", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "new-disabled", "index.ts"))).toBe(true);
	});

	it("validates newly discovered enabled Extensions when preflighting the final set", () => {
		const root = repository();
		writeExtension(root, "extensions", "core");
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: {
				core: { ...entry("Core", "test", true), conflicts: ["newcomer"] },
				newcomer: entry("Newcomer", "test", false),
			},
		});
		const session = createExtensionToggleSession(root, catalog);
		writeExtension(root, "extensions", "newcomer");

		const result = session.apply(new Set(["core"]));

		expect(result).toMatchObject({ status: "rejected", outcomes: [], enabled: ["core", "newcomer"] });
		expect(result.issues).toContain('"core" conflicts with "newcomer".');
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "core", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "newcomer", "index.ts"))).toBe(true);
	});

	it("enables and disables uncataloged Extensions without assigning catalog rules", () => {
		const root = repository();
		writeExtension(root, "extensions", "green");
		writeExtension(root, "extensions-disabled", "constructor");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({ version: 1, extensions: {} }));

		expect(session.extensions.every(({ metadata }) => metadata === undefined)).toBe(true);
		const result = session.apply(new Set(["constructor"]));

		expect(result).toMatchObject({
			status: "applied",
			enabled: ["constructor"],
			outcomes: [
				{ name: "green", direction: "disable", status: "moved" },
				{ name: "constructor", direction: "enable", status: "moved" },
			],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "constructor", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "green", "index.ts"))).toBe(true);

		const disableSession = createExtensionToggleSession(root, parseExtensionCatalog({ version: 1, extensions: {} }));
		const disableResult = disableSession.apply(new Set());
		expect(disableResult).toMatchObject({
			status: "applied",
			outcomes: [{ name: "constructor", direction: "disable", status: "moved" }],
		});
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "constructor", "index.ts"))).toBe(true);
	});

	it("rejects a symlink substituted for a snapshotted Extension directory", () => {
		const root = repository();
		writeExtension(root, "extensions", "alpha");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { alpha: entry("Alpha", "test", false) },
		}));
		const extensionPath = path.join(root, ".pi", "extensions", "alpha");
		const externalPath = path.join(root, "external-alpha");
		fs.renameSync(extensionPath, externalPath);
		fs.symlinkSync(externalPath, extensionPath, "dir");

		const result = session.apply(new Set());

		expect(result).toMatchObject({
			status: "failed",
			outcomes: [{ name: "alpha", direction: "disable", status: "failed" }],
		});
		expect(fs.lstatSync(extensionPath).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(externalPath)).toBe(true);
	});

	it("returns unchanged without touching directories when the requested state already matches", () => {
		const root = repository();
		writeExtension(root, "extensions", "alpha");
		writeExtension(root, "extensions-disabled", "beta");
		const session = createExtensionToggleSession(root, parseExtensionCatalog({
			version: 1,
			extensions: { alpha: entry("Alpha", "test", false), beta: entry("Beta", "test", false) },
		}));

		const result = session.apply(new Set(["alpha"]));

		expect(result).toMatchObject({ status: "unchanged", enabled: ["alpha"], outcomes: [] });
		expect(fs.existsSync(path.join(root, ".pi", "extensions", "alpha", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".pi", "extensions-disabled", "beta", "index.ts"))).toBe(true);
	});
});

function repository(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-toggle-"));
	temporaryDirectories.push(root);
	return root;
}

function writeExtension(root: string, directory: string, name: string): void {
	const extensionPath = path.join(root, ".pi", directory, name);
	fs.mkdirSync(extensionPath, { recursive: true });
	fs.writeFileSync(path.join(extensionPath, "index.ts"), "export {};\n");
}

function entry(displayName: string, pack: string, defaultEnabled: boolean) {
	return { displayName, pack, defaultEnabled, requires: [] as string[], conflicts: [] as string[] };
}
