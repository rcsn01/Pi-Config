import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	mergeProjectCompactionSettings,
	mergeProjectModelSelection,
	parseProjectModelPreferences,
	type ModelSelectionMode,
	type ModelSelectionSettings,
	type ProjectModelPreferences,
} from "./model-config.ts";

export interface ProjectSettingsStore {
	load(): Promise<ProjectModelPreferences>;
	save(mode: ModelSelectionMode, selection: ModelSelectionSettings): Promise<void>;
	syncCompaction(contextWindow: number): Promise<void>;
	/** Repoint the store at the session's profile (uiModelSelector) and settings.json (compaction). */
	setPaths(profilePath: string, compactionPath: string): void;
}

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const PROJECT_SETTINGS_PATH = join(EXTENSION_DIRECTORY, "..", "..", "settings.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a document without validating its contents (the profile's pi-core keys are ignored). */
function readRawDocument(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const document: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(document)) throw new Error("the root value must be a JSON object");
		return document;
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Read and validate a settings.json document (compaction is pi-core and authoritative). */
function readSettingsDocument(path: string): Record<string, unknown> {
	try {
		const document = readRawDocument(path);
		parseProjectModelPreferences(document);
		return document;
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function writeSettingsDocument(path: string, settings: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
		renameSync(temporaryPath, path);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

/**
 * Split-path project settings store. `uiModelSelector` reads/writes go to the
 * session's profile file; the model-derived `compaction` values
 * (threshold/reserveTokens) stay in settings.json per the pi-core policy.
 * `load()` merges the two documents.
 */
export function createProjectSettingsStore(
	path = PROJECT_SETTINGS_PATH,
	compactionPath = path,
): ProjectSettingsStore {
	let profilePath = path;
	let currentCompactionPath = compactionPath;

	return {
		async load() {
			const profileDocument = readRawDocument(profilePath);
			const compactionDocument = readSettingsDocument(currentCompactionPath);
			// The profile's own pi-core compaction values are ignored; settings.json wins.
			const { compaction: _ignored, ...profileWithoutCompaction } = profileDocument;
			return parseProjectModelPreferences({
				...profileWithoutCompaction,
				compaction: compactionDocument.compaction,
			});
		},

		async save(mode, selection) {
			await withFileMutationQueue(profilePath, async () => {
				const selectionSettings = mergeProjectModelSelection(
					readRawDocument(profilePath),
					mode,
					selection,
				);
				writeSettingsDocument(profilePath, selectionSettings);
			});
			await withFileMutationQueue(currentCompactionPath, async () => {
				const settings = mergeProjectCompactionSettings(
					readSettingsDocument(currentCompactionPath),
					selection.contextWindow,
				);
				writeSettingsDocument(currentCompactionPath, settings);
			});
		},

		async syncCompaction(contextWindow) {
			await withFileMutationQueue(currentCompactionPath, async () => {
				const settings = mergeProjectCompactionSettings(
					readSettingsDocument(currentCompactionPath),
					contextWindow,
				);
				writeSettingsDocument(currentCompactionPath, settings);
			});
		},

		setPaths(nextProfilePath, nextCompactionPath) {
			profilePath = nextProfilePath;
			currentCompactionPath = nextCompactionPath;
		},
	};
}
