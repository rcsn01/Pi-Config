import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_PROFILES_KEY,
	PI_DIRECTORY,
	PROFILES_DIRECTORY,
	PROJECT_SETTINGS_PATH,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(contents: string, path: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value)) throw new Error(`Cannot read ${path}: the root value must be a JSON object`);
	return value;
}

function readDocument(path: string): Record<string, unknown> {
	try {
		return parseDocument(readFileSync(path, "utf-8"), path);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(`Cannot read ${path}:`)) throw error;
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function activeProfile(document: Record<string, unknown>): string | undefined {
	const namespace = document[CONFIG_PROFILES_KEY];
	if (!isRecord(namespace) || typeof namespace.active !== "string") return undefined;
	try {
		return validateProfileName(namespace.active);
	} catch {
		return undefined;
	}
}

function withActiveProfile(document: Record<string, unknown>, name: string): Record<string, unknown> {
	const current = document[CONFIG_PROFILES_KEY];
	const namespace = isRecord(current) ? current : {};
	return { ...document, [CONFIG_PROFILES_KEY]: { ...namespace, active: name } };
}

let temporarySequence = 0;
function atomicWrite(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`;
	try {
		writeFileSync(temporaryPath, contents, { encoding: "utf-8", mode: 0o600 });
		renameSync(temporaryPath, path);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function serialize(document: Record<string, unknown>): string {
	return `${JSON.stringify(document, null, 2)}\n`;
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
			return readDocument(profilePath(name));
		},

		getActiveProfile(settings) {
			return activeProfile(settings ?? readDocument(settingsPath));
		},

		loadActiveProfile() {
			const name = readActiveProfileName(settingsPath);
			if (!name) return undefined;
			return { name, document: readDocument(profilePath(name)) };
		},

		async switchProfile(name) {
			validateProfileName(name);
			return withFileMutationQueue(settingsPath, async () => {
				// Validate every input before the first mutation.
				const settingsContents = readFileSync(settingsPath, "utf-8");
				const settings = parseDocument(settingsContents, settingsPath);
				const destinationPath = profilePath(name);
				const destinationContents = readFileSync(destinationPath, "utf-8");
				parseDocument(destinationContents, destinationPath);
				const outgoing = activeProfile(settings);

				if (outgoing === name) {
					return { changed: false, active: name };
				}

				// Only the marker changes; every other settings.json key (pi-core
				// settings) is preserved and profile files are never written.
				atomicWrite(settingsPath, serialize(withActiveProfile(settings, name)));
				return { changed: true, active: name };
			});
		},

		profilePath,
	};
}
