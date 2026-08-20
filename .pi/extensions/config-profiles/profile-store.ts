import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
	isRecord,
	mutateSettingsDocument,
	parseSettingsText,
	readSettingsDocument,
} from "../_shared/settings-document.ts";
import {
	CONFIG_PROFILES_KEY,
	PI_DIRECTORY,
	PROFILES_DIRECTORY,
	PROJECT_SETTINGS_PATH,
	parseActiveProfileName,
	profilePath as resolveProfilePath,
	readActiveProfileName,
	validateProfileName,
} from "../_shared/active-profile.ts";

export { CONFIG_PROFILES_KEY, PI_DIRECTORY, PROFILES_DIRECTORY, PROJECT_SETTINGS_PATH, validateProfileName } from "../_shared/active-profile.ts";

export interface ProfileSwitchResult {
	changed: boolean;
	active: string;
}

export interface ActiveProfile {
	name: string;
	document: Record<string, unknown>;
}

export interface ProfileStore {
	readonly settingsPath: string;
	readonly profilesDirectory: string;
	listProfiles(): string[];
	readProfile(name: string): Record<string, unknown>;
	getActiveProfile(settings?: Record<string, unknown>): string | undefined;
	/** Marker from settings.json plus the profile document; throws when the active profile file is missing. */
	loadActiveProfile(): ActiveProfile | undefined;
	switchProfile(name: string): Promise<ProfileSwitchResult>;
	profilePath(name: string): string;
}

function withActiveProfile(document: Record<string, unknown>, name: string): Record<string, unknown> {
	const current = document[CONFIG_PROFILES_KEY];
	const namespace = isRecord(current) ? current : {};
	return { ...document, [CONFIG_PROFILES_KEY]: { ...namespace, active: name } };
}

export function createProfileStore(options: {
	settingsPath?: string;
	profilesDirectory?: string;
} = {}): ProfileStore {
	const settingsPath = options.settingsPath ?? PROJECT_SETTINGS_PATH;
	const profilesDirectory = options.profilesDirectory ?? PROFILES_DIRECTORY;
	const profilePath = (name: string) => resolveProfilePath(profilesDirectory, name);

	return {
		settingsPath,
		profilesDirectory,

		listProfiles() {
			if (!existsSync(profilesDirectory)) return [];
			return readdirSync(profilesDirectory, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => entry.name.slice(0, -5))
				.filter((name) => {
					try {
						validateProfileName(name);
						return true;
					} catch {
						return false;
					}
				})
				.sort((left, right) => left.localeCompare(right));
		},

		readProfile(name) {
			return readSettingsDocument(profilePath(name), { missing: "throw" });
		},

		getActiveProfile(settings) {
			return parseActiveProfileName(settings ?? readSettingsDocument(settingsPath, { missing: "throw" }));
		},

		loadActiveProfile() {
			const name = readActiveProfileName(settingsPath);
			if (!name) return undefined;
			return { name, document: readSettingsDocument(profilePath(name), { missing: "throw" }) };
		},

		async switchProfile(name) {
			validateProfileName(name);
			// Validate every input before the first mutation.
			parseSettingsText(readFileSync(settingsPath, "utf-8"), settingsPath);
			const destinationPath = profilePath(name);
			parseSettingsText(readFileSync(destinationPath, "utf-8"), destinationPath);
			let changed = false;
			await mutateSettingsDocument(settingsPath, (settings) => {
				if (parseActiveProfileName(settings) === name) return settings;
				changed = true;
				return withActiveProfile(settings, name);
			});
			return { changed, active: name };
		},

		profilePath,
	};
}
