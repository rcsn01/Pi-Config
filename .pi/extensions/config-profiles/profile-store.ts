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
	profilePath as resolveProfilePath,
	profilesDirectoryFor,
	readProjectProfile,
	validateProfileName,
	writeProjectProfile,
} from "../_shared/profile-document.ts";

export { validateProfileName } from "../_shared/profile-document.ts";

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

/**
 * Profile documents live beside the Settings document; the active Profile
 * marker is the `profile` key of `<projectCwd>/.pi/pi-config.json`. Pi still
 * reads `compaction.keepRecentTokens` from settings.json, so activation
 * projects that one Profile-owned value there.
 */
export interface ProfileStore {
	readonly settingsPath: string;
	readonly profilesDirectory: string;
	listProfiles(): string[];
	readProfile(name: string): Record<string, unknown>;
	createProfile(projectCwd: string, name: string, source?: string): Promise<ProfileCreateResult>;
	deleteProfile(projectCwd: string, name: string, options?: ProfileDeleteOptions): Promise<ProfileDeleteResult>;
	switchProfile(projectCwd: string, name: string): Promise<ProfileSwitchResult>;
	profilePath(name: string): string;
}

const DEFAULT_PROFILE_NAME = "default";

/**
 * Pi reads compaction retention from the root settings document rather than
 * Profile-aware extension paths. Project the Profile-owned value there while
 * leaving every other compaction setting under its existing owner.
 */
function profileKeepRecentTokens(profile: Record<string, unknown>): number | undefined {
	const compaction = profile.compaction;
	if (!isRecord(compaction) || !Object.hasOwn(compaction, "keepRecentTokens")) return undefined;
	const value = compaction.keepRecentTokens;
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error("Profile compaction.keepRecentTokens must be a non-negative integer.");
	}
	return value as number;
}

/** Return settings with the Profile's keepRecentTokens applied, or undefined when already current. */
function activatedSettings(
	settings: Record<string, unknown>,
	profile: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const keepRecentTokens = profileKeepRecentTokens(profile);
	if (keepRecentTokens === undefined) return undefined;
	const compaction = isRecord(settings.compaction) ? settings.compaction : {};
	if (compaction.keepRecentTokens === keepRecentTokens) return undefined;
	return { ...settings, compaction: { ...compaction, keepRecentTokens } };
}

export function createProfileStore(options: {
	settingsPath: string;
	profilesDirectory?: string;
}): ProfileStore {
	const { settingsPath } = options;
	const profilesDirectory = options.profilesDirectory ?? profilesDirectoryFor(settingsPath);
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

		async createProfile(projectCwd, name, source) {
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
					const nextSettings = activatedSettings(settings, sourceDocument);
					const previousProfile = readProjectProfile(projectCwd);
					writeSettingsDocument(destinationPath, sourceDocument);

					try {
						if (nextSettings) writeSettingsDocument(settingsPath, nextSettings);
						writeProjectProfile(projectCwd, name);
					} catch (error) {
						// Keep the original mutation error; restore what was written so an
						// extra profile file or projected setting cannot outlive a failure.
						try {
							unlinkSync(destinationPath);
						} catch {}
						if (nextSettings) {
							try {
								writeSettingsDocument(settingsPath, settings);
							} catch {}
						}
						try {
							writeProjectProfile(projectCwd, previousProfile);
						} catch {}
						throw error;
					}

					return { name, source };
				});
			});
		},

		async deleteProfile(projectCwd, name, options = {}) {
			validateProfileName(name);
			if (name === DEFAULT_PROFILE_NAME) {
				throw new Error('The "default" profile cannot be deleted.');
			}

			const targetPath = profilePath(name);
			const replacementPath = profilePath(DEFAULT_PROFILE_NAME);
			return withFileMutationQueue(targetPath, async () => {
				// Validate both documents before changing either file.
				readSettingsDocument(targetPath, { missing: "throw" });
				const replacement = readSettingsDocument(replacementPath, { missing: "throw" });

				return withFileMutationQueue(settingsPath, async () => {
					const settings = readSettingsDocument(settingsPath, { missing: "throw" });
					const active = readProjectProfile(projectCwd);
					const shouldReplaceMarker = options.replaceMarker === true || active === name;
					const markerReplaced = shouldReplaceMarker && active !== DEFAULT_PROFILE_NAME;
					const nextSettings = shouldReplaceMarker ? activatedSettings(settings, replacement) : undefined;

					if (shouldReplaceMarker) {
						if (nextSettings) writeSettingsDocument(settingsPath, nextSettings);
						writeProjectProfile(projectCwd, DEFAULT_PROFILE_NAME);
					}

					try {
						unlinkSync(targetPath);
					} catch (error) {
						if (shouldReplaceMarker) {
							// The marker still references a valid fallback. Do not replace the
							// unlink error with a rollback error.
							try {
								if (nextSettings) writeSettingsDocument(settingsPath, settings);
								writeProjectProfile(projectCwd, active);
							} catch {}
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

		async switchProfile(projectCwd, name) {
			validateProfileName(name);
			// Validate every input before the first mutation.
			parseSettingsText(readFileSync(settingsPath, "utf-8"), settingsPath);
			const destinationPath = profilePath(name);
			const profile = parseSettingsText(readFileSync(destinationPath, "utf-8"), destinationPath);
			profileKeepRecentTokens(profile);
			let changed = false;
			await mutateSettingsDocument(settingsPath, (settings) => {
				const next = activatedSettings(settings, profile);
				if (!next) return settings;
				changed = true;
				return next;
			});
			if (readProjectProfile(projectCwd) !== name) {
				writeProjectProfile(projectCwd, name);
				changed = true;
			}
			return { changed, active: name };
		},

		profilePath,
	};
}
