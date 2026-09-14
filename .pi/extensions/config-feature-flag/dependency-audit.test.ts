import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseExtensionCatalog } from "./catalog.ts";
import {
	collectDependencyEvidence,
	discoverExtensionSources,
	validateDependencyEvidence,
} from "./dependency-audit.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("extension dependency source audit", () => {
	it("finds supported cross-extension references without executing source", () => {
		const root = fixture({
			"extensions/consumer/index.ts": `
				import type {
					ProviderType,
				} from "../provider/types.ts";
				import { value as alias } from "../provider/index.ts";
				export { other } from "../provider/other.ts";
				export * from "../provider/more.ts";
				void import("../provider/dynamic.ts");
				require("../provider/required.cjs");
				const ignored = "import '../../extensions-disabled/not-real/index.ts'";
				// require("../../extensions-disabled/not-real/index.ts")
				void import(someComputedPath);
				import "./same-extension.ts";
				import "../_shared/helper.ts";
				import "external-package";
			`,
			"extensions/consumer/same-extension.ts": "export {};",
			"extensions/_shared/index.ts": "export {};",
			"extensions/_shared/helper.ts": "export {};",
			"extensions-disabled/provider/index.ts": "throw new Error('must not execute'); export const value = 1;",
		});

		const evidence = collectDependencyEvidence(discoverExtensionSources(root));

		expect(evidence.filter((item) => item.consumer === "consumer")).toHaveLength(6);
		expect(new Set(evidence.map((item) => item.provider))).toEqual(new Set(["provider"]));
		expect(new Set(evidence.map((item) => item.kind))).toEqual(new Set(["import"]));
		expect(evidence.map((item) => item.line)).toEqual([...evidence.map((item) => item.line)].sort((a, b) => a - b));
	});

	it("excludes tests, fixtures, declarations, caches, and test harnesses", () => {
		const files: Record<string, string> = {
			"extensions/consumer/index.ts": "export {};",
			"extensions/provider/index.ts": "export {};",
		};
		for (const file of [
			"consumer.test.ts",
			"consumer.spec.js",
			"test-harness.ts",
			"types.d.ts",
			"tests/example.ts",
			"__tests__/example.ts",
			"fixtures/example.ts",
			"__fixtures__/example.ts",
			"cache/example.ts",
			nodeModulesPath(),
		]) files[`extensions/consumer/${file}`] = 'import "../../provider/index.ts";';
		const root = fixture(files);

		expect(collectDependencyEvidence(discoverExtensionSources(root))).toEqual([]);
	});

	it("recognizes required service aliases and namespace calls but not optional access", () => {
		const root = fixture({
			"extensions/_shared/index.ts": "export {};",
			"extensions/_shared/subagent-service.ts": "export const requireSubagentService = () => ({}); export const getSubagentService = () => undefined;",
			"extensions/tools-subagents/index.ts": "export {};",
			"extensions/consumer/index.ts": `
				import { requireSubagentService as need, getSubagentService } from "../_shared/subagent-service.ts";
				import * as services from "../_shared/subagent-service.ts";
				need();
				services.requireSubagentService();
				getSubagentService();
			`,
		});

		const serviceEvidence = collectDependencyEvidence(discoverExtensionSources(root))
			.filter((item) => item.kind === "required-service");
		expect(serviceEvidence).toHaveLength(2);
		expect(serviceEvidence.every((item) => item.provider === "tools-subagents")).toBe(true);
	});

	it("extracts literal child runtime extension names from an as-const array", () => {
		const root = fixture({
			"extensions/tools-subagents/index.ts": "export {};",
			"extensions/tools-subagents/child-execution.ts": `
				const CHILD_RUNTIME_EXTENSIONS = [
					{ name: "session-compaction", path: "one" },
					{ name: "runtime-two", path: "two" },
				] as const;
			`,
			"extensions/session-compaction/index.ts": "export {};",
			"extensions/runtime-two/index.ts": "export {};",
		});

		expect(collectDependencyEvidence(discoverExtensionSources(root)).filter((item) => item.kind === "child-runtime"))
			.toMatchObject([
				{ consumer: "tools-subagents", provider: "runtime-two" },
				{ consumer: "tools-subagents", provider: "session-compaction" },
			]);
	});

	it("fails if child runtime metadata disappears or stops using literal names", () => {
		const missing = fixture({
			"extensions/tools-subagents/index.ts": "export {};",
			"extensions/tools-subagents/child-execution.ts": "export {};",
		});
		expect(() => collectDependencyEvidence(discoverExtensionSources(missing))).toThrow(/CHILD_RUNTIME_EXTENSIONS is missing/);

		const unsupported = fixture({
			"extensions/tools-subagents/index.ts": "export {};",
			"extensions/tools-subagents/child-execution.ts": "const name = 'runtime'; const CHILD_RUNTIME_EXTENSIONS = [{ name }];",
		});
		expect(() => collectDependencyEvidence(discoverExtensionSources(unsupported))).toThrow(/literal name property/);
	});

	it("fails for duplicate extension owners and malformed source", () => {
		const duplicate = fixture({
			"extensions/duplicate/index.ts": "export {};",
			"extensions-disabled/duplicate/index.ts": "export {};",
		});
		expect(() => discoverExtensionSources(duplicate)).toThrow(/exists in both/);

		const malformed = fixture({ "extensions/broken/index.ts": "export {" });
		expect(() => collectDependencyEvidence(discoverExtensionSources(malformed))).toThrow(/Cannot parse .*broken\/index\.ts/);
	});

	it("returns stable, deduplicated diagnostics with normalized paths", () => {
		const catalog = parseExtensionCatalog({
			version: 1,
			extensions: Object.fromEntries(["consumer", "provider"].map((name) => [name, {
				displayName: name,
				pack: "test",
				defaultEnabled: false,
				requires: [],
				conflicts: [],
			}])),
		});
		const repeated = {
			consumer: "consumer",
			provider: "provider",
			kind: "import" as const,
			sourcePath: ".pi\\extensions\\consumer\\index.ts",
			line: 4,
		};

		expect(validateDependencyEvidence(catalog, [repeated, repeated])).toEqual([
			'consumer -> provider (import) at .pi/extensions/consumer/index.ts:4: catalog entry "consumer" must declare "provider" in requires.',
		]);
	});
});

function fixture(files: Readonly<Record<string, string>>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-audit-"));
	temporaryDirectories.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolutePath = path.join(root, ".pi", relativePath);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, contents);
	}
	return root;
}

function nodeModulesPath(): string {
	return "node_modules/example.ts";
}
