import {
	mutateSettingsDocument,
	readSettingsDocument,
} from "./settings-document.ts";
import {
	mergeProjectModelSelection,
	parseProjectModelPreferences,
	validateConcreteModelSelection,
	type ConcreteModelSelection,
	type ModelSelectionMode,
	type StoredModelSelectionSettings,
} from "./model-selection.ts";

export interface ModelSelectionStore {
	load(mode: ModelSelectionMode): Promise<StoredModelSelectionSettings | undefined>;
	save(mode: ModelSelectionMode, selection: ConcreteModelSelection): Promise<void>;
	/** Repoint the store at the session's Profile file. */
	setPath(path: string): void;
}

export class ModelSelectionStoreError extends Error {
	readonly operation: "load" | "save";
	readonly mode: ModelSelectionMode;
	readonly path: string;
	readonly cause: unknown;

	constructor(
		operation: "load" | "save",
		mode: ModelSelectionMode,
		path: string,
		cause: unknown,
	) {
		const preposition = operation === "load" ? "from" : "to";
		super(
			`Cannot ${operation} ${mode} model selection ${preposition} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "ModelSelectionStoreError";
		this.operation = operation;
		this.mode = mode;
		this.path = path;
		this.cause = cause;
	}
}

/**
 * Profile-aware persistence for `uiModelSelector` selections. Reads validate
 * the complete namespace before returning one mode. Writes preserve the other
 * mode, compaction settings, and unrelated Settings document fields.
 */
export function createModelSelectionStore(path: string): ModelSelectionStore {
	let currentPath = path;

	return {
		async load(mode) {
			const operationPath = currentPath;
			try {
				const preferences = parseProjectModelPreferences(readSettingsDocument(operationPath));
				return preferences.profiles[mode];
			} catch (cause) {
				throw new ModelSelectionStoreError("load", mode, operationPath, cause);
			}
		},

		async save(mode, selection) {
			const operationPath = currentPath;
			try {
				const validated = validateConcreteModelSelection(selection);
				const contextWindow = validated.contextWindow;
				if (contextWindow === undefined) {
					throw new Error("Model selection contextWindow must be a positive integer.");
				}
				await mutateSettingsDocument(operationPath, (document) =>
					mergeProjectModelSelection(document, mode, {
						...validated,
						contextWindow,
					})
				);
			} catch (cause) {
				throw new ModelSelectionStoreError("save", mode, operationPath, cause);
			}
		},

		setPath(nextPath) {
			currentPath = nextPath;
		},
	};
}
