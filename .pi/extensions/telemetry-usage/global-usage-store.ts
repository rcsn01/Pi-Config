/**
 * Global usage ledger and scanner.
 *
 * Scans every session file under the pi agent sessions directory, classifies
 * usage per session (per mode, per model), and persists a ledger cache at
 * `~/.pi/agent/global-usage.json`. The ledger is a cache only — every file is
 * revalidated by mtime + size + header session id, so stale or missing entries
 * are re-parsed automatically and deleting the ledger is always safe.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseSessionEntries, type FileEntry } from "@earendil-works/pi-coding-agent";
import {
	buildGlobalUsageSnapshot,
	classifySessionEntries,
	GLOBAL_MODES,
	type GlobalSessionRecord,
	type GlobalUsageSnapshot,
	type SessionActivityEntry,
	type SessionUsageEntry,
} from "../_shared/global-usage.ts";
import { asRecord } from "../_shared/usage.ts";

const CACHE_VERSION = 3;
const MAX_CONCURRENT_READS = 8;
const FIRST_MESSAGE_LIMIT = 160;

/** [id, modeIdx, modelIdx, input, output, cacheRead, cacheWrite, cost, turns, timestamp] */
type CacheEntryRow = [
	id: string,
	mode: number,
	model: number,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	cost: number,
	turns: number,
	timestamp: number,
];

/** [id, kind, toolName, timestamp] where kind is 0=assistant and 1=tool. */
type CacheActivityRow = [
	id: string,
	kind: 0 | 1,
	toolName: string,
	timestamp: number,
];

interface CachedFile {
	mtime: number;
	size: number;
	headerId: string;
	cwd: string;
	created: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	parentSession?: string;
	models: string[];
	entries: CacheEntryRow[];
	activity: CacheActivityRow[];
}

interface GlobalUsageCache {
	version: number;
	updatedAt: number;
	files: Record<string, CachedFile>;
}

export interface ScanGlobalUsageOptions {
	onProgress?: (loaded: number, total: number) => void;
	/** Override the sessions directory (tests). */
	sessionsDir?: string;
	/** Override the ledger path (tests). */
	cachePath?: string;
}

export async function scanGlobalUsage(options: ScanGlobalUsageOptions = {}): Promise<GlobalUsageSnapshot> {
	const sessionsDir = options.sessionsDir ?? path.join(getAgentDir(), "sessions");
	const cachePath = options.cachePath ?? path.join(getAgentDir(), "global-usage.json");
	const files = await enumerateSessionFiles(sessionsDir);
	const previous = await loadCache(cachePath);

	const fresh: GlobalUsageCache = { version: CACHE_VERSION, updatedAt: Date.now(), files: {} };
	const records: GlobalSessionRecord[] = [];
	let changed = previous.updatedAt === 0;
	let loaded = 0;

	const onLoaded = () => {
		loaded++;
		options.onProgress?.(loaded, files.length);
	};

	await runPool(files, MAX_CONCURRENT_READS, async (file) => {
		const cached = previous.files[file];
		try {
			const stats = await fs.promises.stat(file);
			const header = await readHeader(file);
			if (cached && isCachedFileUsable(cached) &&
				cached.mtime === stats.mtimeMs &&
				cached.size === stats.size &&
				cached.headerId === header.id) {
				records.push(fromCachedFile(file, cached));
				fresh.files[file] = cached;
			} else {
				changed = true;
				const record = await parseSessionRecord(file, header);
				if (record) {
					records.push(record);
					fresh.files[file] = toCachedFile(record, stats);
				}
			}
		} catch {
			changed = true;
			// Unreadable or malformed file: skip it (and drop any cached copy).
		} finally {
			onLoaded();
		}
	});

	if (changed || files.length !== Object.keys(previous.files).length) {
		await persistCache(cachePath, fresh);
	}

	return buildGlobalUsageSnapshot(records);
}

async function enumerateSessionFiles(sessionsDir: string): Promise<string[]> {
	try {
		const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			try {
				const names = (await fs.promises.readdir(path.join(sessionsDir, entry.name))).filter((name) =>
					name.endsWith(".jsonl")
				);
				for (const name of names) files.push(path.join(sessionsDir, entry.name, name));
			} catch {
				// Unreadable project directory: skip.
			}
		}
		return files;
	} catch {
		// Sessions directory does not exist yet.
		return [];
	}
}

interface SessionHeaderInfo {
	id: string;
	cwd: string;
	created: string;
	parentSession?: string;
}

/** Read just the first line of a session file — its header. */
async function readHeader(file: string): Promise<SessionHeaderInfo> {
	const handle = await fs.promises.open(file, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const newline = buffer.indexOf(0x0a, 0, bytesRead);
		const line = buffer.toString("utf8", 0, newline === -1 ? bytesRead : newline).trim();
		const header = JSON.parse(line) as Record<string, unknown>;
		if (header?.type !== "session") throw new Error("Missing session header");
		return {
			id: typeof header.id === "string" ? header.id : "",
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			created: typeof header.timestamp === "string" ? header.timestamp : "",
			parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined,
		};
	} finally {
		await handle.close();
	}
}

async function parseSessionRecord(
	file: string,
	header: SessionHeaderInfo,
): Promise<GlobalSessionRecord | undefined> {
	const content = await fs.promises.readFile(file, "utf8");
	const entries = parseSessionEntries(content);
	if (entries.length === 0) return undefined;
	const { name, firstMessage, messageCount } = extractSessionMeta(entries);
	return {
		file,
		id: header.id,
		cwd: header.cwd,
		created: header.created,
		name,
		firstMessage,
		messageCount,
		parentSession: header.parentSession,
		entries: classifySessionEntries(entries),
		activity: extractSessionActivity(entries),
	};
}

function entryTimestamp(entry: FileEntry): number | undefined {
	if (entry.type === "session") return undefined;
	const timestamp = Date.parse(entry.timestamp);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function extractSessionActivity(entries: readonly FileEntry[]): SessionActivityEntry[] {
	const activity: SessionActivityEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const timestamp = entryTimestamp(entry);
		if (entry.message.role === "assistant") {
			if (entry.message.stopReason === "error") continue;
			activity.push({
				id: entry.id,
				kind: "assistant",
				...(timestamp === undefined ? {} : { timestamp }),
			});
		} else if (entry.message.role === "toolResult") {
			const toolName = typeof entry.message.toolName === "string" ? entry.message.toolName.trim() : "";
			if (!toolName) continue;
			activity.push({
				id: entry.id,
				kind: "tool",
				toolName,
				...(timestamp === undefined ? {} : { timestamp }),
			});
		}
	}
	return activity;
}

function extractSessionMeta(
	entries: readonly FileEntry[],
): { name?: string; firstMessage: string; messageCount: number } {
	let name: string | undefined;
	let firstMessage = "";
	let messageCount = 0;
	for (const entry of entries) {
		if (entry.type === "session_info") {
			const trimmed = typeof entry.name === "string" ? entry.name.trim() : "";
			name = trimmed || undefined;
		} else if (entry.type === "message") {
			messageCount++;
			if (!firstMessage && entry.message.role === "user") {
				const text = messageText(entry.message.content).trim();
				if (text) firstMessage = text.slice(0, FIRST_MESSAGE_LIMIT);
			}
		}
	}
	return { name, firstMessage, messageCount };
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const record = asRecord(block);
			return record?.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.join(" ");
}

function toCachedFile(record: GlobalSessionRecord, stats: { mtimeMs: number; size: number }): CachedFile {
	const models: string[] = [];
	const modelIndex = new Map<string, number>();
	const modeIndex = new Map(GLOBAL_MODES.map((mode, index) => [mode, index]));
	const rows: CacheEntryRow[] = record.entries.map((entry) => {
		let index = modelIndex.get(entry.model);
		if (index === undefined) {
			index = models.length;
			modelIndex.set(entry.model, index);
			models.push(entry.model);
		}
		return [
			entry.id,
			modeIndex.get(entry.mode) ?? 0,
			index,
			entry.input,
			entry.output,
			entry.cacheRead,
			entry.cacheWrite,
			entry.cost,
			entry.turns,
			entry.timestamp ?? 0,
		];
	});
	const activity: CacheActivityRow[] = (record.activity ?? []).map((entry) => [
		entry.id,
		entry.kind === "tool" ? 1 : 0,
		entry.toolName ?? "",
		entry.timestamp ?? 0,
	]);
	return {
		mtime: stats.mtimeMs,
		size: stats.size,
		headerId: record.id,
		cwd: record.cwd,
		created: record.created,
		name: record.name,
		firstMessage: record.firstMessage,
		messageCount: record.messageCount,
		parentSession: record.parentSession,
		models,
		entries: rows,
		activity,
	};
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCachedFileUsable(cached: CachedFile): cached is CachedFile {
	if (!finiteNonNegative(cached.mtime) || !finiteNonNegative(cached.size) ||
		typeof cached.headerId !== "string" || typeof cached.cwd !== "string" ||
		typeof cached.created !== "string" || typeof cached.firstMessage !== "string" ||
		!Number.isInteger(cached.messageCount) || cached.messageCount < 0 ||
		!Array.isArray(cached.models) || !cached.models.every((model) => typeof model === "string") ||
		!Array.isArray(cached.entries) || !Array.isArray(cached.activity)) return false;
	if (cached.name !== undefined && typeof cached.name !== "string") return false;
	if (cached.parentSession !== undefined && typeof cached.parentSession !== "string") return false;
	for (const row of cached.entries) {
		if (!Array.isArray(row) || row.length !== 10 || typeof row[0] !== "string" ||
			!Number.isInteger(row[1]) || row[1] < 0 || row[1] >= GLOBAL_MODES.length ||
			!Number.isInteger(row[2]) || row[2] < 0 || row[2] >= cached.models.length ||
			!row.slice(3).every(finiteNonNegative)) return false;
	}
	for (const row of cached.activity) {
		if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== "string" ||
			(row[1] !== 0 && row[1] !== 1) || typeof row[2] !== "string" ||
			!finiteNonNegative(row[3])) return false;
		if (row[1] === 1 && !row[2].trim()) return false;
	}
	return true;
}

function fromCachedFile(file: string, cached: CachedFile): GlobalSessionRecord {
	const entries: SessionUsageEntry[] = [];
	for (const row of cached.entries) {
		if (!Array.isArray(row) || row.length < 10) continue;
		const mode = GLOBAL_MODES[row[1]];
		if (!mode) continue;
		entries.push({
			id: row[0],
			mode,
			model: cached.models[row[2]] ?? "unknown",
			input: row[3],
			output: row[4],
			cacheRead: row[5],
			cacheWrite: row[6],
			cost: row[7],
			turns: row[8],
			timestamp: row[9] || undefined,
		});
	}
	const activity: SessionActivityEntry[] = [];
	for (const row of Array.isArray(cached.activity) ? cached.activity : []) {
		if (!Array.isArray(row) || row.length < 4 || typeof row[0] !== "string") continue;
		const kind = row[1] === 0 ? "assistant" : row[1] === 1 ? "tool" : undefined;
		if (!kind) continue;
		const toolName = typeof row[2] === "string" ? row[2].trim() : "";
		if (kind === "tool" && !toolName) continue;
		activity.push({
			id: row[0],
			kind,
			...(kind === "tool" ? { toolName } : {}),
			...(typeof row[3] === "number" && Number.isFinite(row[3]) && row[3] > 0 ? { timestamp: row[3] } : {}),
		});
	}
	return {
		file,
		id: cached.headerId,
		cwd: cached.cwd,
		created: cached.created,
		name: cached.name,
		firstMessage: cached.firstMessage,
		messageCount: cached.messageCount,
		parentSession: cached.parentSession,
		entries,
		activity,
	};
}

async function loadCache(cachePath: string): Promise<GlobalUsageCache> {
	try {
		const content = await fs.promises.readFile(cachePath, "utf8");
		const parsed = JSON.parse(content) as GlobalUsageCache;
		if (parsed?.version !== CACHE_VERSION || !finiteNonNegative(parsed.updatedAt) ||
			typeof parsed.files !== "object" || parsed.files === null || Array.isArray(parsed.files)) {
			return { version: CACHE_VERSION, updatedAt: 0, files: {} };
		}
		return parsed;
	} catch {
		// Missing or corrupt ledger: full rescan.
		return { version: CACHE_VERSION, updatedAt: 0, files: {} };
	}
}

async function persistCache(cachePath: string, cache: GlobalUsageCache): Promise<void> {
	try {
		const tmpPath = `${cachePath}.tmp`;
		await fs.promises.writeFile(tmpPath, JSON.stringify(cache));
		await fs.promises.rename(tmpPath, cachePath);
	} catch {
		// Ledger writes are best-effort; the in-memory scan result stays valid.
	}
}

async function runPool<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(concurrency, items.length)) },
		async () => {
			while (true) {
				const index = nextIndex++;
				if (index >= items.length) return;
				await task(items[index]!);
			}
		},
	);
	await Promise.all(workers);
}
