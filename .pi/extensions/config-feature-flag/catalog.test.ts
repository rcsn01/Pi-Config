import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadExtensionCatalog,
	parseExtensionCatalog,
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

		expect(discovered.filter((name) => !checkedIn.extensions[name])).toEqual([]);
	});

	it("accepts a dependency-closed, conflict-free selection", () => {
		expect(validateExtensionSelection(catalog, new Set(["core", "worker"]))).toEqual([]);
	});

	it("explains missing requirements and conflicts", () => {
		expect(validateExtensionSelection(catalog, new Set(["worker", "loop"]))).toEqual([
			'"worker" requires "core" to be enabled.',
			'"worker" conflicts with "loop".',
		]);
	});

	it("rejects invalid references and invalid default closure", () => {
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
	});
});