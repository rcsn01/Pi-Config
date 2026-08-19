import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const SHARED_DIRECTORY = dirname(fileURLToPath(import.meta.url));
/** Path to the project-level settings.json shared by all extensions. */
export const PROJECT_SETTINGS_PATH = join(SHARED_DIRECTORY, "..", "..", "settings.json");

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSettingsText(contents: string, path: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(contents);
		if (!isRecord(value)) throw new Error("the root value must be a JSON object");
		return value;
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function readSettingsDocument(
	path: string,
	options: { missing?: "empty" | "throw" } = {},
): Record<string, unknown> {
	if ((options.missing ?? "empty") === "empty" && !existsSync(path)) return {};
	try {
		return parseSettingsText(readFileSync(path, "utf-8"), path);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(`Cannot read ${path}:`)) throw error;
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

let temporarySequence = 0;
export function writeSettingsDocument(path: string, document: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(temporaryPath, path);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

export function mutateSettingsDocument(
	path: string,
	mutate: (document: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return withFileMutationQueue(path, async () => {
		const document = mutate(readSettingsDocument(path));
		writeSettingsDocument(path, document);
		return document;
	});
}
