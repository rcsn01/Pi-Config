import * as fs from "node:fs";
import * as path from "node:path";

export interface ExtensionCatalogEntry {
	displayName: string;
	pack: string;
	defaultEnabled: boolean;
	requires: string[];
	conflicts: string[];
}

export interface ExtensionCatalog {
	version: 1;
	extensions: Record<string, ExtensionCatalogEntry>;
}

export function loadExtensionCatalog(cwd: string): ExtensionCatalog {
	const catalogPath = path.join(cwd, ".pi", "extensions", "catalog.json");
	const parsed: unknown = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
	return parseExtensionCatalog(parsed);
}

export function parseExtensionCatalog(value: unknown): ExtensionCatalog {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.extensions)) {
		throw new Error("Extension catalog must contain version 1 and an extensions object.");
	}

	const extensions: Record<string, ExtensionCatalogEntry> = {};
	for (const [name, entry] of Object.entries(value.extensions)) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !isRecord(entry)) {
			throw new Error(`Invalid extension catalog entry: ${name}`);
		}
		if (
			typeof entry.displayName !== "string" ||
			typeof entry.pack !== "string" ||
			typeof entry.defaultEnabled !== "boolean" ||
			!isStringArray(entry.requires) ||
			!isStringArray(entry.conflicts)
		) {
			throw new Error(`Invalid metadata for extension: ${name}`);
		}
		extensions[name] = {
			displayName: entry.displayName,
			pack: entry.pack,
			defaultEnabled: entry.defaultEnabled,
			requires: [...entry.requires],
			conflicts: [...entry.conflicts],
		};
	}

	for (const [name, entry] of Object.entries(extensions)) {
		for (const related of [...entry.requires, ...entry.conflicts]) {
			if (!(related in extensions)) {
				throw new Error(`Extension "${name}" references unknown extension "${related}".`);
			}
			if (related === name) {
				throw new Error(`Extension "${name}" cannot reference itself.`);
			}
		}
	}

	const defaults = new Set(
		Object.entries(extensions)
			.filter(([, entry]) => entry.defaultEnabled)
			.map(([name]) => name),
	);
	const defaultIssues = validateExtensionSelection({ version: 1, extensions }, defaults);
	if (defaultIssues.length > 0) {
		throw new Error(`Invalid default extension set: ${defaultIssues.join(" ")}`);
	}

	return { version: 1, extensions };
}

export function validateExtensionSelection(
	catalog: ExtensionCatalog,
	enabled: ReadonlySet<string>,
): string[] {
	const issues: string[] = [];
	const seenConflicts = new Set<string>();

	for (const name of [...enabled].sort()) {
		const entry = catalog.extensions[name];
		if (!entry) continue;

		for (const requirement of entry.requires) {
			if (!enabled.has(requirement)) {
				issues.push(`"${name}" requires "${requirement}" to be enabled.`);
			}
		}

		for (const conflict of entry.conflicts) {
			if (!enabled.has(conflict)) continue;
			const key = [name, conflict].sort().join("\0");
			if (!seenConflicts.has(key)) {
				seenConflicts.add(key);
				issues.push(`"${name}" conflicts with "${conflict}".`);
			}
		}
	}

	return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}