import {
	mutateSettingsDocument,
	PROJECT_SETTINGS_PATH,
	readSettingsDocument as readRawDocument,
} from "../_shared/settings-document.ts";

export { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
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
			await mutateSettingsDocument(profilePath, (document) =>
				mergeProjectModelSelection(document, mode, selection)
			);
			await mutateSettingsDocument(currentCompactionPath, (document) => {
				parseProjectModelPreferences(document);
				return mergeProjectCompactionSettings(document, selection.contextWindow);
			});
		},

		async syncCompaction(contextWindow) {
			await mutateSettingsDocument(currentCompactionPath, (document) => {
				parseProjectModelPreferences(document);
				return mergeProjectCompactionSettings(document, contextWindow);
			});
		},

		setPaths(nextProfilePath, nextCompactionPath) {
			profilePath = nextProfilePath;
			currentCompactionPath = nextCompactionPath;
		},
	};
}
