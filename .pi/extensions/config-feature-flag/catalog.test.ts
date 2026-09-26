import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadExtensionCatalog,
	orderExtensionsByRequirements,
	parseExtensionCatalog,
	validateExtensionDisablements,
	validateExtensionSelection,
} from "./catalog.ts";

const catalog = parseExtensionCatalog({
	version: 1,
	extensions: {
		core: {
			displayName: "Core",
			pack: "core",
			defaultEnabled: true,
			requires: [],
			conflicts: [],
		},
		worker: {
			displayName: "Worker",
			pack: "autonomy",
			defaultEnabled: false,
			requires: ["core"],
			conflicts: ["loop"],
		},
		loop: {
			displayName: "Loop",
			pack: "autonomy",
			defaultEnabled: false,
			requires: [],
			conflicts: [],
		},
	},
});

describe("extension catalog", () => {
	it("parses the checked-in catalog and covers discovered extensions", () => {
		const repositoryRoot = path.resolve("..");
		const checkedIn = loadExtensionCatalog(repositoryRoot);
		const discovered = ["extensions", "extensions-disabled"].flatMap((directory) =>
			fs.readdirSync(path.join(repositoryRoot, ".pi", directory), { withFileTypes: true })
				.filter((entry) =>
					entry.isDirectory() &&
					fs.existsSync(path.join(repositoryRoot, ".pi", directory, entry.name, "index.ts")),
				)
				.map((entry) => entry.name),
		);

		expect(Object.keys(checkedIn.extensions).sort()).toEqual([...new Set(discovered)].sort());
	});

	it("records the checked-in hard runtime dependencies", () => {
		const checkedIn = loadExtensionCatalog(path.resolve(".."));

		expect(checkedIn.extensions["provider-usage"]?.requires).toEqual(["provider-codex"]);
		expect(checkedIn.extensions["tools-subagents"]?.requires).toEqual([
			"policy-permissions",
			"session-compaction",
		]);
		expect(checkedIn.extensions["workflows-engine"]?.requires).toEqual(["tools-subagents"]);
		expect(validateExtensionSelection(
			checkedIn,
			new Set(["policy-permissions", "session-compaction", "workflows-engine"]),
		)).toContain('"workflows-engine" requires "tools-subagents" to be enabled.');
	});

	it("accepts a dependency-closed, conflict-free selection", () => {
		expect(validateExtensionSelection(catalog, new Set(["core", "worker"]))).toEqual([]);
	});

	it("allows dependency-closed batch removal but keeps the single-disable message", () => {
		expect(validateExtensionDisablements(
			catalog,
			new Set(["core", "worker"]),
			new Set(),
		)).toEqual([]);
		expect(validateExtensionSelection(catalog, new Set())).toEqual([]);

		expect(validateExtensionDisablements(
			catalog,
			new Set(["core", "worker"]),
			new Set(["worker"]),
		)).toEqual([
			'Cannot disable "core": enabled extension "worker" depends on it. Disable "worker" first.',
		]);
		expect(validateExtensionSelection(catalog, new Set(["worker"]))).toEqual([
			'"worker" requires "core" to be enabled.',
		]);
		expect(validateExtensionDisablements(
			catalog,
			new Set(["core"]),
			new Set(),
		)).toEqual([]);
	});

	it("explains missing requirements and conflicts", () => {
		expect(validateExtensionSelection(catalog, new Set(["worker", "loop"]))).toEqual([
			'"worker" requires "core" to be enabled.',
			'"worker" conflicts with "loop".',
		]);
	});

	it.each([
		["requires", "duplicate requires entry"],
		["conflicts", "duplicate conflicts entry"],
	] as const)("rejects duplicate %s relationships", (relationship, message) => {
		const value = catalogValue({ a: [], b: [] });
		value.extensions.a![relationship] = ["b", "b"];
		expect(() => parseExtensionCatalog(value)).toThrow(message);
	});

	it("rejects two-node and longer requirement cycles with deterministic paths", () => {
		expect(() => parseExtensionCatalog(catalogValue({ a: ["b"], b: ["a"] })))
			.toThrow("a → b → a");
		expect(() => parseExtensionCatalog(catalogValue({ c: ["a"], a: ["b"], b: ["c"] })))
			.toThrow("a → b → c → a");
	});

	it("accepts an acyclic dependency diamond", () => {
		expect(() => parseExtensionCatalog(catalogValue({ a: ["b", "c"], b: ["d"], c: ["d"], d: [] })))
			.not.toThrow();
	});

	it("rejects invalid references and default dependency closure", () => {
		expect(() =>
			parseExtensionCatalog({
				version: 1,
				extensions: {
					worker: {
						displayName: "Worker",
						pack: "autonomy",
						defaultEnabled: true,
						requires: ["missing"],
						conflicts: [],
					},
				},
			}),
		).toThrow(/unknown extension/);
		expect(() => parseExtensionCatalog(catalogValue({ worker: ["constructor"] })))
			.toThrow(/references unknown extension "constructor"/);

		expect(() => parseExtensionCatalog({
			version: 1,
			extensions: {
				core: { displayName: "Core", pack: "core", defaultEnabled: false, requires: [], conflicts: [] },
				worker: { displayName: "Worker", pack: "test", defaultEnabled: true, requires: ["core"], conflicts: [] },
			},
		})).toThrow(/Invalid default extension set: "worker" requires "core" to be enabled/);
	});
});

describe("extension requirement ordering", () => {
	it("orders requirements before dependents on enable and after them on disable", () => {
		expect(orderExtensionsByRequirements(["worker", "core"], catalog, "enable")).toEqual(["core", "worker"]);
		expect(orderExtensionsByRequirements(["worker", "core"], catalog, "disable")).toEqual(["worker", "core"]);
	});

	it("re-sorts newly eligible names when ordering a dependency diamond", () => {
		const diamond = parseExtensionCatalog({
			version: 1,
			extensions: {
				a: { displayName: "A", pack: "test", defaultEnabled: false, requires: ["b", "c"], conflicts: [] },
				b: { displayName: "B", pack: "test", defaultEnabled: false, requires: ["root"], conflicts: [] },
				c: { displayName: "C", pack: "test", defaultEnabled: false, requires: ["root"], conflicts: [] },
				root: { displayName: "Root", pack: "test", defaultEnabled: false, requires: [], conflicts: [] },
				z: { displayName: "Z", pack: "test", defaultEnabled: false, requires: [], conflicts: [] },
			},
		});
		const names = ["z", "c", "root", "a", "b"];

		expect(orderExtensionsByRequirements(names, diamond, "enable")).toEqual(["root", "b", "c", "a", "z"]);
		expect(orderExtensionsByRequirements(names, diamond, "disable")).toEqual(["a", "b", "c", "root", "z"]);
	});

	it("orders unrelated names with localeCompare and deduplicates the input", () => {
		const emptyCatalog = parseExtensionCatalog({ version: 1, extensions: {} });

		expect(orderExtensionsByRequirements(["zeta", "alpha", "beta"], emptyCatalog, "enable"))
			.toEqual(["alpha", "beta", "zeta"]);
		expect(orderExtensionsByRequirements(["zeta", "alpha", "zeta"], emptyCatalog, "disable"))
			.toEqual(["alpha", "zeta"]);
		expect(orderExtensionsByRequirements([], emptyCatalog, "disable")).toEqual([]);
	});

	it("orders only requested names and treats uncataloged prototype names as edge-free", () => {
		expect(orderExtensionsByRequirements(["worker"], catalog, "enable")).toEqual(["worker"]);
		expect(orderExtensionsByRequirements(["core"], catalog, "disable")).toEqual(["core"]);

		const emptyCatalog = parseExtensionCatalog({ version: 1, extensions: {} });
		for (const direction of ["enable", "disable"] as const) {
			expect(orderExtensionsByRequirements(["constructor"], emptyCatalog, direction)).toEqual(["constructor"]);
		}
	});

	it.each(["enable", "disable"] as const)("keeps the defensive cycle error for malformed catalogs when direction is %s", (direction) => {
		const malformedCatalog = {
			version: 1 as const,
			extensions: {
				a: { displayName: "A", pack: "test", defaultEnabled: false, requires: ["b"], conflicts: [] },
				b: { displayName: "B", pack: "test", defaultEnabled: false, requires: ["a"], conflicts: [] },
			},
		};

		expect(() => orderExtensionsByRequirements(["a", "b"], malformedCatalog, direction))
			.toThrow("Extension requirements contain a cycle.");
	});
});

function catalogValue(requirements: Readonly<Record<string, readonly string[]>>) {
	return {
		version: 1 as const,
		extensions: Object.fromEntries(Object.entries(requirements).map(([name, requires]) => [name, {
			displayName: name,
			pack: "test",
			defaultEnabled: false,
			requires: [...requires],
			conflicts: [] as string[],
		}])),
	};
}