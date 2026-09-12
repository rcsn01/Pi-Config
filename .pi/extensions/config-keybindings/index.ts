import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { isRecord, writeSettingsDocument } from "../_shared/settings-document.ts";

const KEYBINDINGS_FILENAME = "keybindings.json";
const THINKING_CYCLE_KEY = "app.thinking.cycle";

type JsonObject = Record<string, unknown>;

function isFileNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function warnKeybindings(message: string, configPath: string, error?: unknown): void {
	const detail = error instanceof Error ? `: ${error.message}` : "";
	console.warn(`[config-keybindings] ${message} (${configPath})${detail}`);
}

export function ensureThinkingCycleBinding(
	configPath = path.join(getAgentDir(), KEYBINDINGS_FILENAME),
): void {
	let config: JsonObject;

	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!isRecord(parsed)) {
			warnKeybindings("Keybindings config must contain a JSON object; leaving it unchanged", configPath);
			return;
		}
		config = parsed;
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			warnKeybindings("Could not read keybindings config; leaving it unchanged", configPath, error);
			return;
		}
		config = {};
	}

	const thinkingCycleBinding = config[THINKING_CYCLE_KEY];
	if (Array.isArray(thinkingCycleBinding) && thinkingCycleBinding.length === 0) return;

	config[THINKING_CYCLE_KEY] = [];

	try {
		writeSettingsDocument(configPath, config);
	} catch (error) {
		warnKeybindings("Could not update keybindings config", configPath, error);
	}
}

export default function (_pi: ExtensionAPI): void {
	ensureThinkingCycleBinding();
}
