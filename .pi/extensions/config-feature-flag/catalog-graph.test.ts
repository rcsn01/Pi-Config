import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadExtensionCatalog, type ExtensionCatalog } from "./catalog.ts";
import {
	collectDependencyEvidence,
	discoverExtensionSources,
	REQUIRED_SERVICE_CONTRACTS,
	validateDependencyEvidence,
} from "./dependency-audit.ts";

const repositoryRoot = path.resolve("..");

describe("import-derived extension dependencies", () => {
	it("matches the checked-in catalog", () => {
		const catalog = loadExtensionCatalog(repositoryRoot);
		const evidence = collectDependencyEvidence(discoverExtensionSources(repositoryRoot));

		expect(validateDependencyEvidence(catalog, evidence)).toEqual([]);
		expect(new Set(evidence.map(({ consumer, provider }) => `${consumer} -> ${provider}`))).toEqual(new Set([
			"provider-usage -> provider-codex",
			"tools-subagents -> session-compaction",
			"workflows-engine -> tools-subagents",
		]));
	});

	it.each([
		["provider-usage", "provider-codex"],
		["tools-subagents", "session-compaction"],
		["workflows-engine", "tools-subagents"],
	])("reports source evidence when %s no longer requires %s", (consumer, provider) => {
		const catalog = catalogWithoutRequirement(consumer, provider);
		const evidence = collectDependencyEvidence(discoverExtensionSources(repositoryRoot));

		const diagnostics = validateDependencyEvidence(catalog, evidence);
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics.every((diagnostic) => diagnostic.includes(`${consumer} -> ${provider}`))).toBe(true);
	});

	it("pins the shared subagent service contract to its provider", () => {
		for (const contract of REQUIRED_SERVICE_CONTRACTS) {
			const modulePath = path.join(repositoryRoot, ".pi", "extensions", ...contract.module.split("/"));
			const moduleSource = fs.readFileSync(modulePath, "utf8");
			const providerSource = fs.readFileSync(
				path.join(repositoryRoot, ".pi", "extensions", contract.provider, "index.ts"),
				"utf8",
			);
			expect(moduleSource).toMatch(new RegExp(`export\\s+function\\s+${contract.exportName}\\b`));
			expect(providerSource).toMatch(/\bregisterSubagentService\b/);
		}
	});
});

describe("explicit extension dependency policy", () => {
	it("keeps safety requirements that source scanning cannot infer", () => {
		const catalog = loadExtensionCatalog(repositoryRoot);
		expect(catalog.extensions["tools-subagents"]?.requires).toContain("policy-permissions");
		expect(catalog.extensions["tools-worktree"]?.requires).toEqual(["policy-permissions"]);
		expect(catalog.extensions["workflows-goal"]?.requires).toEqual(["policy-permissions"]);
		expect(catalog.extensions["workflows-plan"]?.requires).toEqual(["policy-permissions", "tools-ask-user"]);
		expect(catalog.extensions["integration-fleet"]?.requires).toEqual([
			"policy-permissions",
			"tools-subagents",
			"tools-worktree",
		]);
	});

	it("keeps Fleet and Goal mutually exclusive", () => {
		const catalog = loadExtensionCatalog(repositoryRoot);
		expect(catalog.extensions["integration-fleet"]?.conflicts).toContain("workflows-goal");
		expect(catalog.extensions["workflows-goal"]?.conflicts).toContain("integration-fleet");
	});

	it("keeps Goal and Plan Mode mutually exclusive", () => {
		const catalog = loadExtensionCatalog(repositoryRoot);
		expect(catalog.extensions["workflows-goal"]?.conflicts).toContain("workflows-plan");
		expect(catalog.extensions["workflows-plan"]?.conflicts).toContain("workflows-goal");
	});
});

function catalogWithoutRequirement(consumer: string, provider: string): ExtensionCatalog {
	const catalog = loadExtensionCatalog(repositoryRoot);
	return {
		...catalog,
		extensions: {
			...catalog.extensions,
			[consumer]: {
				...catalog.extensions[consumer]!,
				requires: catalog.extensions[consumer]!.requires.filter((name) => name !== provider),
			},
		},
	};
}
