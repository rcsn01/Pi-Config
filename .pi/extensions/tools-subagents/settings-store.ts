import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Top-level settings.json key under which all subagent configuration is stored. */
export const SUBAGENTS_SETTINGS_KEY = "subagents";

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
/** Path to the project-level settings.json shared by all extensions. */
export const PROJECT_SETTINGS_PATH = join(EXTENSION_DIRECTORY, "..", "..", "settings.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the full settings.json document, tolerating a missing file but rejecting a malformed root. */
export function readSettingsDocument(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(value)) throw new Error("the root value must be a JSON object");
		return value;
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Atomically write a full settings.json document (temp file + rename). */
export function writeSettingsDocument(path: string, settings: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(temporaryPath, path);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

export interface SubagentsSettingsStore {
	readonly settingsPath: string;
	/** Full settings.json document (all top-level keys). */
	readDocument(): Record<string, unknown>;
	/** Just the subagents namespace (empty object when absent). */
	readNamespace(): Record<string, unknown>;
	/** Read-modify-write the subagents namespace atomically, preserving every other settings key. */
	updateNamespace(
		mutate: (namespace: Record<string, unknown>) => Record<string, unknown>,
		base?: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	/** Persist a fully-formed subagents namespace atomically, preserving every other settings key. */
	writeNamespace(namespace: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createSubagentsSettingsStore(path = PROJECT_SETTINGS_PATH): SubagentsSettingsStore {
	function readDocument(): Record<string, unknown> {
		return readSettingsDocument(path);
	}

	function readNamespace(): Record<string, unknown> {
		const document = readDocument();
		const value = document[SUBAGENTS_SETTINGS_KEY];
		if (value === undefined) return {};
		if (!isRecord(value)) throw new Error(`Subagent settings "${SUBAGENTS_SETTINGS_KEY}" must be a JSON object.`);
		return value;
	}

	async function updateNamespace(
		mutate: (namespace: Record<string, unknown>) => Record<string, unknown>,
		base?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return withFileMutationQueue(path, async () => {
			const document = readDocument();
			const current = structuredClone(base ?? document[SUBAGENTS_SETTINGS_KEY] ?? {});
			if (!isRecord(current)) throw new Error(`Subagent settings "${SUBAGENTS_SETTINGS_KEY}" must be a JSON object.`);
			const next = mutate(current);
			writeSettingsDocument(path, { ...document, [SUBAGENTS_SETTINGS_KEY]: next });
			return next;
		});
	}

	async function writeNamespace(namespace: Record<string, unknown>): Promise<Record<string, unknown>> {
		return withFileMutationQueue(path, async () => {
			const document = readDocument();
			writeSettingsDocument(path, { ...document, [SUBAGENTS_SETTINGS_KEY]: namespace });
			return namespace;
		});
	}

	return {
		settingsPath: path,
		readDocument,
		readNamespace,
		updateNamespace,
		writeNamespace,
	};
}
