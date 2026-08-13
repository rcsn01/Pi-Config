import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	mergeProjectModelSelection,
	parseProjectModelPreferences,
	type ModelSelectionMode,
	type ModelSelectionSettings,
	type ProjectModelPreferences,
} from "./model-config.ts";

export interface ProjectSettingsStore {
	load(): Promise<ProjectModelPreferences>;
	save(mode: ModelSelectionMode, selection: ModelSelectionSettings): Promise<void>;
}

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const PROJECT_SETTINGS_PATH = join(EXTENSION_DIRECTORY, "..", "..", "settings.json");

function readSettingsDocument(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const document: unknown = JSON.parse(readFileSync(path, "utf-8"));
		parseProjectModelPreferences(document);
		return document as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function createProjectSettingsStore(path = PROJECT_SETTINGS_PATH): ProjectSettingsStore {
	return {
		async load() {
			return parseProjectModelPreferences(readSettingsDocument(path));
		},

		async save(mode, selection) {
			await withFileMutationQueue(path, async () => {
				const settings = mergeProjectModelSelection(readSettingsDocument(path), mode, selection);
				mkdirSync(dirname(path), { recursive: true });
				const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
				try {
					writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
					renameSync(temporaryPath, path);
				} finally {
					if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
				}
			});
		},
	};
}
