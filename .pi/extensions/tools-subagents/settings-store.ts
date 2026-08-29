import {
	isRecord,
	mutateSettingsDocument,
	readSettingsDocument,
} from "../_shared/settings-document.ts";

/** Top-level settings.json key under which all subagent configuration is stored. */
export const SUBAGENTS_SETTINGS_KEY = "subagents";

export interface SubagentsSettingsStore {
	readonly settingsPath: string;
	/** Full settings document (all top-level keys). */
	readDocument(): Record<string, unknown>;
	/** Just the subagents namespace (empty object when absent). */
	readNamespace(): Record<string, unknown>;
	/** Read-modify-write the subagents namespace atomically, preserving every other settings key. */
	updateNamespace(
		mutate: (namespace: Record<string, unknown>) => Record<string, unknown>,
		base?: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	/** Persist a fully-formed subagents namespace atomically, preserving every other settings key. */
	writeNamespace(namespace: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** Repoint the store at the session's profile file (default: settings.json). */
	setSettingsPath(path: string): void;
}

export function createSubagentsSettingsStore(path: string): SubagentsSettingsStore {
	let settingsPath = path;

	function readDocument(): Record<string, unknown> {
		return readSettingsDocument(settingsPath);
	}

	function readNamespace(): Record<string, unknown> {
		const document = readDocument();
		const value = document[SUBAGENTS_SETTINGS_KEY];
		if (value === undefined) return {};
		if (!isRecord(value)) throw new Error(`Subagent settings "${SUBAGENTS_SETTINGS_KEY}" must be a JSON object.`);
		return value;
	}

	async function updateNamespace(
		mutate: (namespace: Record<string, unknown>) => Record<string, unknown>,
		base?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		let next: Record<string, unknown>;
		await mutateSettingsDocument(settingsPath, (document) => {
			const current = structuredClone(base ?? document[SUBAGENTS_SETTINGS_KEY] ?? {});
			if (!isRecord(current)) throw new Error(`Subagent settings "${SUBAGENTS_SETTINGS_KEY}" must be a JSON object.`);
			next = mutate(current);
			return { ...document, [SUBAGENTS_SETTINGS_KEY]: next };
		});
		return next!;
	}

	async function writeNamespace(namespace: Record<string, unknown>): Promise<Record<string, unknown>> {
		await mutateSettingsDocument(settingsPath, (document) => ({
			...document,
			[SUBAGENTS_SETTINGS_KEY]: namespace,
		}));
		return namespace;
	}

	return {
		get settingsPath() {
			return settingsPath;
		},
		readDocument,
		readNamespace,
		updateNamespace,
		writeNamespace,
		setSettingsPath(nextPath) {
			settingsPath = nextPath;
		},
	};
}
