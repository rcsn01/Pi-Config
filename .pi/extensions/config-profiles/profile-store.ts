import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	mutateSettingsDocument,
	parseSettingsText,
	readSettingsDocument,
	writeSettingsDocument,
} from "../_shared/settings-document.ts";
import {
	CONFIG_PROFILES_KEY,
	PI_DIRECTORY,
	PROFILES_DIRECTORY,
	PROJECT_SETTINGS_PATH,
	parseActiveProfileName,
	profilePath as resolveProfilePath,
	validateProfileName,
} from "../_shared/active-profile.ts";

export { CONFIG_PROFILES_KEY, PI_DIRECTORY, PROFILES_DIRECTORY, PROJECT_SETTINGS_PATH, validateProfileName } from "../_shared/active-profile.ts";

export interface ProfileSwitchResult {
	changed: boolean;
	active: string;
}

export interface ProfileCreateResult {
	name: string;
	source: string | undefined;
}

export interface ProfileDeleteOptions {
	/** Force the project marker to the fallback when this session owns the deleted profile. */
	replaceMarker?: boolean;
}

export interface ProfileDeleteResult {
	name: string;
	replacement: "default";
	markerReplaced: boolean;
}

export interface ProfileStore {
	readonly settingsPath: string;
	readonly profilesDirectory: string;
	listProfiles(): string[];
	readProfile(name: string): Record<string, unknown>;
	createProfile(name: string, source?: string): Promise<ProfileCreateResult>;
	deleteProfile(name: string, options?: ProfileDeleteOptions): Promise<ProfileDeleteResult>;
	switchProfile(name: string): Promise<ProfileSwitchResult>;
	profilePath(name: string): string;
}

const DEFAULT_PROFILE_NAME = "default";

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

		async createProfile(name, source) {
			validateProfileName(name);
			if (source !== undefined) {
				validateProfileName(source);
				if (source === name) throw new Error(`Cannot copy profile "${name}" onto itself.`);
			}

			const destinationPath = profilePath(name);
			const sourcePath = source === undefined ? settingsPath : profilePath(source);
			return withFileMutationQueue(destinationPath, async () => {
				if (existsSync(destinationPath)) throw new Error(`Profile "${name}" already exists.`);

				return withFileMutationQueue(settingsPath, async () => {
					const settings = readSettingsDocument(settingsPath, { missing: "throw" });
					const sourceDocument = source === undefined
						? settings
						: readSettingsDocument(sourcePath, { missing: "throw" });
					writeSettingsDocument(destinationPath, withActiveProfile(sourceDocument, name));

					try {
						writeSettingsDocument(settingsPath, withActiveProfile(settings, name));
					} catch (error) {
						try {
							unlinkSync(destinationPath);
						} catch {
							// Keep the original mutation error. The marker was not changed, so
							// an extra profile file cannot affect the active binding.
						}
						throw error;
					}

					return { name, source };
				});
			});
		},

		async deleteProfile(name, options = {}) {
			validateProfileName(name);
			if (name === DEFAULT_PROFILE_NAME) {
				throw new Error('The "default" profile cannot be deleted.');
			}

			const targetPath = profilePath(name);
			const replacementPath = profilePath(DEFAULT_PROFILE_NAME);
			return withFileMutationQueue(targetPath, async () => {
				// Validate both documents before changing either file.
				readSettingsDocument(targetPath, { missing: "throw" });
				readSettingsDocument(replacementPath, { missing: "throw" });

				return withFileMutationQueue(settingsPath, async () => {
					const settings = readSettingsDocument(settingsPath, { missing: "throw" });
					const active = parseActiveProfileName(settings);
					const shouldReplaceMarker = options.replaceMarker === true || active === name;
					const markerReplaced = shouldReplaceMarker && active !== DEFAULT_PROFILE_NAME;

					if (markerReplaced) {
						writeSettingsDocument(settingsPath, withActiveProfile(settings, DEFAULT_PROFILE_NAME));
					}

					try {
						unlinkSync(targetPath);
					} catch (error) {
						if (markerReplaced) {
							try {
								writeSettingsDocument(settingsPath, settings);
							} catch {
								// The marker was already changed to a valid fallback. Do not
								// replace the unlink error with a rollback error.
							}
						}
						throw error;
					}

					return {
						name,
						replacement: DEFAULT_PROFILE_NAME,
						markerReplaced,
					};
				});
			});
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
