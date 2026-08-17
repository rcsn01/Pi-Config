import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const CONFIG_PROFILES_KEY = "configProfiles";

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const PI_DIRECTORY = join(EXTENSION_DIRECTORY, "..", "..");
export const PROJECT_SETTINGS_PATH = join(PI_DIRECTORY, "settings.json");
export const PROFILES_DIRECTORY = join(PI_DIRECTORY, "profiles");

export interface ProfileSwitchResult {
	changed: boolean;
	active: string;
}

export interface ProfileStore {
	readonly settingsPath: string;
	readonly profilesDirectory: string;
	listProfiles(): string[];
	readProfile(name: string): Record<string, unknown>;
	readSettings(): Record<string, unknown>;
	getActiveProfile(settings?: Record<string, unknown>): string | undefined;
	synchronizeActiveProfile(): Promise<string | undefined>;
	switchProfile(name: string): Promise<ProfileSwitchResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Profile names are filename stems, never paths or names including `.json`. */
export function validateProfileName(name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "." || name === ".." || extname(name) === ".json") {
		throw new Error(`Invalid profile name "${name}". Use letters, numbers, dots, underscores, or hyphens.`);
	}
	return name;
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

function restore(path: string, previous: string | undefined): void {
	if (previous === undefined) {
		if (existsSync(path)) unlinkSync(path);
		return;
	}
	atomicWrite(path, previous);
}

export function createProfileStore(options: {
	settingsPath?: string;
	profilesDirectory?: string;
} = {}): ProfileStore {
	const settingsPath = options.settingsPath ?? PROJECT_SETTINGS_PATH;
	const profilesDirectory = options.profilesDirectory ?? PROFILES_DIRECTORY;
	const profilePath = (name: string) => join(profilesDirectory, `${validateProfileName(name)}.json`);

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

		readSettings() {
			return readDocument(settingsPath);
		},

		getActiveProfile(settings) {
			return activeProfile(settings ?? readDocument(settingsPath));
		},

		async synchronizeActiveProfile() {
			return withFileMutationQueue(settingsPath, async () => {
				const settings = readDocument(settingsPath);
				const active = activeProfile(settings);
				if (!active) return undefined;
				const destination = profilePath(active);
				if (!existsSync(destination)) {
					throw new Error(`Active settings profile "${active}" does not exist at ${destination}`);
				}
				atomicWrite(destination, serialize(settings));
				return active;
			});
		},

		async switchProfile(name) {
			validateProfileName(name);
			return withFileMutationQueue(settingsPath, async () => {
				// Validate every input before the first mutation.
				const settingsContents = readFileSync(settingsPath, "utf-8");
				const settings = parseDocument(settingsContents, settingsPath);
				const destinationPath = profilePath(name);
				const destinationContents = readFileSync(destinationPath, "utf-8");
				const destination = parseDocument(destinationContents, destinationPath);
				const outgoing = activeProfile(settings);

				if (outgoing === name) {
					atomicWrite(destinationPath, serialize(settings));
					return { changed: false, active: name };
				}

				const selected = withActiveProfile(destination, name);
				const outgoingPath = outgoing ? profilePath(outgoing) : undefined;
				const previousOutgoing = outgoingPath && existsSync(outgoingPath)
					? readFileSync(outgoingPath, "utf-8")
					: undefined;
				const previousDestination = destinationContents;
				const touched: string[] = [];

				try {
					if (outgoingPath) {
						atomicWrite(outgoingPath, serialize(settings));
						touched.push(outgoingPath);
					}
					atomicWrite(settingsPath, serialize(selected));
					touched.push(settingsPath);
					atomicWrite(destinationPath, serialize(selected));
					touched.push(destinationPath);
				} catch (error) {
					// Best-effort rollback keeps this coordinated operation all-or-nothing.
					for (const path of touched.reverse()) {
						try {
							if (path === settingsPath) restore(path, settingsContents);
							else if (path === destinationPath) restore(path, previousDestination);
							else restore(path, previousOutgoing);
						} catch {
							// Preserve the original mutation failure.
						}
					}
					throw error;
				}

				return { changed: true, active: name };
			});
		},
	};
}
