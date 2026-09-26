import * as fs from "node:fs";
import * as path from "node:path";
import {
	validateExtensionDisablements,
	validateExtensionSelection,
	type ExtensionCatalog,
	type ExtensionCatalogEntry,
} from "./catalog.ts";

const EXTENSIONS_DIR = ".pi/extensions";
const DISABLED_DIR = ".pi/extensions-disabled";
const PROTECTED = new Set(["_shared", "config-feature-flag"]);

export interface ExtensionInfo {
	name: string;
	enabled: boolean;
	protected: boolean;
	metadata?: ExtensionCatalogEntry;
}

export type ExtensionToggleDirection = "enable" | "disable";
export type ExtensionToggleOutcomeStatus = "moved" | "failed" | "skipped";

export interface ExtensionToggleOutcome {
	name: string;
	direction: ExtensionToggleDirection;
	status: ExtensionToggleOutcomeStatus;
}

export interface ExtensionToggleResult {
	status: "rejected" | "unchanged" | "applied" | "partial" | "failed";
	issues: string[];
	outcomes: ExtensionToggleOutcome[];
	enabled: string[];
}

export interface ExtensionToggleSession {
	readonly extensions: readonly ExtensionInfo[];
	apply(desiredEnabled: ReadonlySet<string>): ExtensionToggleResult;
}

export function createExtensionToggleSession(cwd: string, catalog: ExtensionCatalog): ExtensionToggleSession {
	const enabledDirs = listExtensionDirs(cwd, EXTENSIONS_DIR);
	const disabledDirs = listExtensionDirs(cwd, DISABLED_DIR);
	const extensions: ExtensionInfo[] = [];

	for (const name of enabledDirs) {
		extensions.push({
			name,
			enabled: true,
			protected: PROTECTED.has(name),
			metadata: catalogEntry(catalog, name),
		});
	}
	for (const name of disabledDirs) {
		if (enabledDirs.has(name)) continue;
		extensions.push({
			name,
			enabled: false,
			protected: PROTECTED.has(name),
			metadata: catalogEntry(catalog, name),
		});
	}
	extensions.sort((left, right) => left.name.localeCompare(right.name));

	const snapshotNames = new Set(extensions.map(({ name }) => name));
	return {
		extensions,
		apply(desiredEnabled: ReadonlySet<string>): ExtensionToggleResult {
			const enabled = listExtensionDirs(cwd, EXTENSIONS_DIR);
			const issues = [...desiredEnabled]
				.filter((name) => !snapshotNames.has(name))
				.sort()
				.map((name) => `Unknown extension "${name}" was requested.`);

			for (const extension of extensions) {
				if (extension.protected && enabled.has(extension.name) && !desiredEnabled.has(extension.name)) {
					issues.push(`"${extension.name}" is protected and cannot be disabled.`);
				}
			}

			const finalEnabled = new Set([...enabled].filter((name) => !snapshotNames.has(name)));
			for (const name of desiredEnabled) finalEnabled.add(name);
			if (issues.length === 0) {
				const disablementIssues = validateExtensionDisablements(catalog, enabled, finalEnabled);
				issues.push(...(disablementIssues.length > 0
					? disablementIssues
					: validateExtensionSelection(catalog, finalEnabled)));
			}

			if (issues.length > 0) {
				return { status: "rejected", issues, outcomes: [], enabled: [...enabled].sort() };
			}

			const failedPaths = new Set<string>();
			const enableNames: string[] = [];
			const disableNames: string[] = [];

			for (const extension of extensions) {
				const state = inspectExtensionPaths(cwd, extension.name);
				const wantsEnabled = desiredEnabled.has(extension.name);
				if (state.enabled === "invalid" || state.disabled === "invalid" ||
					(state.enabled === "extension" && state.disabled === "extension")) {
					failedPaths.add(extension.name);
					(wantsEnabled ? enableNames : disableNames).push(extension.name);
					continue;
				}

				if (state.enabled === "absent" && state.disabled === "absent") {
					failedPaths.add(extension.name);
					(wantsEnabled ? enableNames : disableNames).push(extension.name);
					continue;
				}

				const currentlyEnabled = state.enabled === "extension";
				if (currentlyEnabled === wantsEnabled) continue;
				(wantsEnabled ? enableNames : disableNames).push(extension.name);
			}

			const orderedNames = [
				...orderByRequirements(disableNames, catalog, "disable"),
				...orderByRequirements(enableNames, catalog, "enable"),
			];
			const outcomes: ExtensionToggleOutcome[] = [];
			const workingEnabled = new Set(enabled);

			for (const name of orderedNames) {
				const direction: ExtensionToggleDirection = desiredEnabled.has(name) ? "enable" : "disable";
				if (failedPaths.has(name)) {
					outcomes.push({ name, direction, status: "failed" });
					continue;
				}

				const state = inspectExtensionPaths(cwd, name);
				const source = direction === "enable" ? state.disabled : state.enabled;
				const destination = direction === "enable" ? state.enabled : state.disabled;
				if (source === "invalid" || destination === "invalid" ||
					(source === "extension" && destination === "extension")) {
					outcomes.push({ name, direction, status: "failed" });
					continue;
				}
				if (source === "absent" && destination === "extension") continue;
				if (source !== "extension" || destination !== "absent") {
					outcomes.push({ name, direction, status: "failed" });
					continue;
				}

				const prospectiveEnabled = new Set(workingEnabled);
				if (direction === "enable") prospectiveEnabled.add(name);
				else prospectiveEnabled.delete(name);
				if (introducesValidationIssues(catalog, workingEnabled, prospectiveEnabled)) {
					outcomes.push({ name, direction, status: "skipped" });
					continue;
				}

				const sourcePath = path.join(cwd, direction === "enable" ? DISABLED_DIR : EXTENSIONS_DIR, name);
				const destinationPath = path.join(cwd, direction === "enable" ? EXTENSIONS_DIR : DISABLED_DIR, name);
				try {
					fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
					fs.renameSync(sourcePath, destinationPath);
					if (direction === "enable") workingEnabled.add(name);
					else workingEnabled.delete(name);
					outcomes.push({ name, direction, status: "moved" });
				} catch {
					outcomes.push({ name, direction, status: "failed" });
				}
			}

			const movedCount = outcomes.filter(({ status }) => status === "moved").length;
			const hasFailures = outcomes.some(({ status }) => status !== "moved");
			const status: ExtensionToggleResult["status"] = hasFailures
				? movedCount > 0 ? "partial" : "failed"
				: movedCount > 0 ? "applied" : "unchanged";
			return { status, issues: [], outcomes, enabled: [...workingEnabled].sort() };
		},
	};
}

type ExtensionPathKind = "absent" | "extension" | "invalid";

interface ExtensionPathState {
	enabled: ExtensionPathKind;
	disabled: ExtensionPathKind;
}

function catalogEntry(catalog: ExtensionCatalog, name: string): ExtensionCatalogEntry | undefined {
	return Object.hasOwn(catalog.extensions, name) ? catalog.extensions[name] : undefined;
}

function inspectExtensionPaths(cwd: string, name: string): ExtensionPathState {
	return {
		enabled: inspectExtensionPath(path.join(cwd, EXTENSIONS_DIR, name)),
		disabled: inspectExtensionPath(path.join(cwd, DISABLED_DIR, name)),
	};
}

function inspectExtensionPath(extensionPath: string): ExtensionPathKind {
	try {
		const stat = fs.lstatSync(extensionPath);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return "invalid";
		return fs.existsSync(path.join(extensionPath, "index.ts")) ? "extension" : "invalid";
	} catch (error) {
		return isMissingPath(error) ? "absent" : "invalid";
	}
}

function isMissingPath(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function orderByRequirements(
	names: readonly string[],
	catalog: ExtensionCatalog,
	direction: ExtensionToggleDirection,
): string[] {
	const remaining = new Set(names);
	const ordered: string[] = [];
	while (remaining.size > 0) {
		const eligible = [...remaining].filter((name) => {
			if (direction === "enable") {
				return (catalogEntry(catalog, name)?.requires ?? []).every((requirement) => !remaining.has(requirement));
			}
			return ![...remaining].some((dependent) => catalogEntry(catalog, dependent)?.requires.includes(name));
		}).sort((left, right) => left.localeCompare(right));
		const next = eligible[0];
		if (next === undefined) throw new Error("Extension requirements contain a cycle.");
		remaining.delete(next);
		ordered.push(next);
	}
	return ordered;
}

function introducesValidationIssues(
	catalog: ExtensionCatalog,
	current: ReadonlySet<string>,
	prospective: ReadonlySet<string>,
): boolean {
	const existingIssues = new Set(validateExtensionSelection(catalog, current));
	return validateExtensionSelection(catalog, prospective).some((issue) => !existingIssues.has(issue));
}

function listExtensionDirs(cwd: string, directory: string): Set<string> {
	const names = new Set<string>();
	const fullPath = path.join(cwd, directory);
	try {
		for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (fs.existsSync(path.join(fullPath, entry.name, "index.ts"))) names.add(entry.name);
		}
	} catch {
		// An Extension root may not exist yet.
	}
	return names;
}
