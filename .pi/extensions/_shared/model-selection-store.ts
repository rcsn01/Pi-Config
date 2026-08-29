import {
	mutateSettingsDocument,
	readSettingsDocument as readRawDocument,
} from "./settings-document.ts";
import {
	mergeProjectModelSelection,
	parseProjectModelPreferences,
	type ModelSelectionMode,
	type ModelSelectionSettings,
	type ProjectModelPreferences,
} from "./model-selection.ts";

export interface ProjectSettingsStore {
	load(): Promise<ProjectModelPreferences>;
	save(mode: ModelSelectionMode, selection: ModelSelectionSettings): Promise<void>;
	/** Repoint the store at the session's profile file (default: settings.json). */
	setPath(path: string): void;
}

/**
 * Project settings store for `uiModelSelector` selections. Reads and writes go
 * to the session's profile file, or settings.json when no profile is bound.
 * Compaction policy belongs to the auto-compact extension; this store never
 * writes pi's native `compaction` settings.
 */
export function createProjectSettingsStore(path: string): ProjectSettingsStore {
	let currentPath = path;

	return {
		async load() {
			return parseProjectModelPreferences(readRawDocument(currentPath));
		},

		async save(mode, selection) {
			await mutateSettingsDocument(currentPath, (document) =>
				mergeProjectModelSelection(document, mode, selection)
			);
		},

		setPath(nextPath) {
			currentPath = nextPath;
		},
	};
}
