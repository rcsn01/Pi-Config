/**
 * Persistent per-project history store for ui-message-history.
 *
 * Entries are keyed by the working directory they were submitted in, so each
 * project recalls its own history. Writes are debounced and atomic (tmp file
 * + rename via writeSettingsDocument), and merged with the file on disk so
 * parallel pi instances in other projects don't clobber each other's entries.
 */

import { readFileSync } from "node:fs";
import { writeSettingsDocument } from "../_shared/settings-document.ts";

const MAX_ENTRIES = 200;
const SAVE_DEBOUNCE_MS = 400;

export interface HistoryStore {
	/** Re-read the file, picking up entries other pi instances wrote. */
	load(): void;
	/** The live entry list for one working directory; index 0 = most recent. */
	listFor(cwd: string): string[];
	/** Record a submitted or Ctrl+C-dismissed message for the given cwd. */
	record(cwd: string, text: string): void;
	/** Persist any pending debounced write immediately. */
	flush(): void;
}

export function createHistoryStore({ file }: { file: string }): HistoryStore {
	let data: Record<string, string[]> = {};
	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	function load(): void {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, string[]>;
				return;
			}
		} catch {
			// Missing or unreadable file: start fresh.
		}
		data = {};
	}

	function listFor(cwd: string): string[] {
		let list = data[cwd];
		if (!Array.isArray(list)) {
			list = [];
			data[cwd] = list;
		}
		return list;
	}

	function record(cwd: string, text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		const list = listFor(cwd);
		// Consecutive duplicates are skipped; re-submitting an older entry
		// moves it to the top, like a shell history.
		if (list[0] === trimmed) return;
		const existing = list.indexOf(trimmed);
		if (existing > 0) list.splice(existing, 1);
		list.unshift(trimmed);
		if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
		scheduleSave();
	}

	function scheduleSave(): void {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveNow(), SAVE_DEBOUNCE_MS);
	}

	function saveNow(): void {
		saveTimer = undefined;
		try {
			// Merge with whatever is on disk: another pi instance (e.g. in
			// another project) may have written other entries since we loaded.
			let merged = data;
			try {
				const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, string[]>;
				if (onDisk && typeof onDisk === "object" && !Array.isArray(onDisk)) {
					merged = { ...onDisk, ...data };
				}
			} catch {
				// First write or unreadable file — write our data as-is.
			}
			writeSettingsDocument(file, merged);
		} catch (err) {
			console.error("[previous-message] failed to persist history:", err);
		}
	}

	function flush(): void {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = undefined;
			saveNow();
		}
	}

	return { load, listFor, record, flush };
}