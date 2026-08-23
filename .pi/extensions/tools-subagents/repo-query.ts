import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

export const REPO_QUERY_LIMITS = {
	maxOperations: 24,
	maxConcurrency: 6,
	readLines: { default: 200, maximum: 1_000 },
	grepMatches: { default: 50, maximum: 200 },
	grepContext: { default: 0, maximum: 10 },
	findResults: { default: 100, maximum: 500 },
	lsEntries: { default: 200, maximum: 500 },
	fileResults: { default: 50, maximum: 200 },
} as const;

export const REPO_QUERY_KINDS = [
	"read",
	"grep",
	"find",
	"ls",
	"files",
	"git_status",
	"git_diff",
] as const;

export type RepoQueryKind = (typeof REPO_QUERY_KINDS)[number];
export type RepoQueryDiffMode = "summary" | "staged" | "unstaged" | "uncommitted";

export interface RepoQueryOperation {
	id?: string;
	kind: RepoQueryKind;
	path?: string;
	pattern?: string;
	glob?: string;
	query?: string;
	offset?: number;
	limit?: number;
	context?: number;
	ignoreCase?: boolean;
	literal?: boolean;
	includeHidden?: boolean;
	mode?: RepoQueryDiffMode;
}

export interface RepoQueryRequest {
	operations: RepoQueryOperation[];
}

export interface ResolvedRepoQueryOperation extends RepoQueryOperation {
	id: string;
	kind: RepoQueryKind;
	path?: string;
}

export interface RepoQueryContext {
	cwd: string;
	signal?: AbortSignal;
	maxBytes?: number;
	maxLines?: number;
}

export type RepoQueryOperationOutput = string | { text?: string };

export type RepoQueryOperationExecutor = (
	operation: ResolvedRepoQueryOperation,
	signal?: AbortSignal,
) => Promise<RepoQueryOperationOutput>;

export interface RepoQueryOperationRecord {
	id: string;
	kind: RepoQueryKind;
	body: string;
	durationMs: number;
	success: boolean;
	error?: string;
	deduplicatedFrom?: string;
}

export interface RepoQueryOperationDetails {
	id: string;
	kind: RepoQueryKind;
	durationMs: number;
	success: boolean;
	truncated: boolean;
	deduplicatedFrom?: string;
	error?: string;
}

export interface RepoQueryDetails {
	operations: RepoQueryOperationDetails[];
	truncated: boolean;
	originalOutputBytes: number;
	originalOutputLines: number;
	outputBytes: number;
	outputLines: number;
}

export interface RepoQueryExecutionResult {
	text: string;
	details: RepoQueryDetails;
}

export interface RepoQueryFormatOptions {
	maxBytes?: number;
	maxLines?: number;
}

export interface RepoQueryFormattedResult {
	text: string;
	truncated: boolean;
	originalOutputBytes: number;
	originalOutputLines: number;
	outputBytes: number;
	outputLines: number;
	operationTruncated: boolean[];
}

const TRUNCATION_NOTICE =
	"[Output truncated. Use a follow-up repo_query operation with offset, limit, or a narrower search.]";
/**
 * Validate, safely resolve, deduplicate, and run a batch of repository queries.
 * The executor is the adapter seam. It receives normalized absolute paths and
 * never needs to know how the Pi tools or Git helpers are implemented.
 */
export async function executeRepoQuery(
	input: unknown,
	context: RepoQueryContext,
	executeOperation: RepoQueryOperationExecutor,
): Promise<RepoQueryExecutionResult> {
	if (typeof executeOperation !== "function") {
		throw new Error("repo_query requires an operation executor.");
	}
	const operations = await validateAndResolveOperations(input, context.cwd, context.signal);
	const records = await runOperations(operations, context.signal, executeOperation);
	const formatted = formatRepoQueryResults(records, context);

	return {
		text: formatted.text,
		details: {
			operations: records.map((record, index) => ({
				id: record.id,
				kind: record.kind,
				durationMs: record.durationMs,
				success: record.success,
				truncated: formatted.operationTruncated[index],
				deduplicatedFrom: record.deduplicatedFrom,
				error: record.error,
			})),
			truncated: formatted.truncated,
			originalOutputBytes: formatted.originalOutputBytes,
			originalOutputLines: formatted.originalOutputLines,
			outputBytes: formatted.outputBytes,
			outputLines: formatted.outputLines,
		},
	};
}

/** Normalize and validate a request without executing any operation. */
export async function validateAndResolveOperations(
	input: unknown,
	cwd: string,
	signal?: AbortSignal,
): Promise<ResolvedRepoQueryOperation[]> {
	throwIfAborted(signal);
	if (!isRecord(input) || !Array.isArray(input.operations)) {
		throw new Error("repo_query requires an operations array.");
	}
	if (input.operations.length < 1 || input.operations.length > REPO_QUERY_LIMITS.maxOperations) {
		throw new Error(`repo_query requires 1-${REPO_QUERY_LIMITS.maxOperations} operations.`);
	}
	if (typeof cwd !== "string" || cwd.trim() === "") {
		throw new Error("repo_query requires a working directory.");
	}

	const root = path.resolve(cwd);
	const resolved: ResolvedRepoQueryOperation[] = [];
	const usedIds = new Set<string>();
	let generatedId = 1;

	for (const rawOperation of input.operations) {
		throwIfAborted(signal);
		if (!isRecord(rawOperation)) throw new Error("Each repo_query operation must be an object.");

		const kind = requireKind(rawOperation.kind);
		const id = resolveOperationId(rawOperation.id, usedIds, () => {
			while (usedIds.has(`op-${generatedId}`)) generatedId++;
			return `op-${generatedId++}`;
		});
		usedIds.add(id);

		const operation = await normalizeOperation(rawOperation, kind, id, root, signal);
		resolved.push(operation);
	}

	return resolved;
}

/** Format records with fair per-operation allocation under Pi's output limits. */
export function formatRepoQueryResults(
	records: RepoQueryOperationRecord[],
	options: RepoQueryFormatOptions = {},
): RepoQueryFormattedResult {
	const maxBytes = normalizeOutputLimit(options.maxBytes, DEFAULT_MAX_BYTES);
	const maxLines = normalizeOutputLimit(options.maxLines, DEFAULT_MAX_LINES);
	const bodies = records.map((record) => normalizeBody(record.body));
	const prefixes = records.map(formatOperationPrefix);
	const completeSections = records.map((record, index) =>
		formatSection(prefixes[index], bodies[index], false),
	);
	const completeText = completeSections.join("\n\n");
	const originalOutputBytes = Buffer.byteLength(completeText, "utf8");
	const originalOutputLines = countLines(completeText);

	if (records.length === 0) {
		return {
			text: "",
			truncated: false,
			originalOutputBytes,
			originalOutputLines,
			outputBytes: 0,
			outputLines: 0,
			operationTruncated: [],
		};
	}
	if (originalOutputBytes <= maxBytes && originalOutputLines <= maxLines) {
		return {
			text: completeText,
			truncated: false,
			originalOutputBytes,
			originalOutputLines,
			outputBytes: originalOutputBytes,
			outputLines: originalOutputLines,
			operationTruncated: records.map(() => false),
		};
	}

	const fixedBytes = prefixes.reduce((sum, prefix) => sum + byteLength(prefix), 0)
		+ Math.max(0, records.length - 1) * 2;
	const fixedLines = prefixes.reduce((sum, prefix) => sum + countLines(prefix), 0)
		+ Math.max(0, records.length - 1);
	// Reserve a newline before every possible body and a continuation notice for
	// every operation. Short sections give those reservations back implicitly.
	const reservedBytes = records.length * (1 + 1 + byteLength(TRUNCATION_NOTICE));
	const reservedLines = records.length;
	const bodyByteBudget = Math.max(0, maxBytes - fixedBytes - reservedBytes);
	const bodyLineBudget = Math.max(0, maxLines - fixedLines - reservedLines);
	const bodyByteNeeds = bodies.map(byteLength);
	const bodyLineNeeds = bodies.map(countLines);
	const bodyByteBudgets = allocateFair(bodyByteNeeds, bodyByteBudget);
	const bodyLineBudgets = allocateFair(bodyLineNeeds, bodyLineBudget);

	const operationTruncated: boolean[] = [];
	const sections = records.map((record, index) => {
		const body = bodies[index];
		const truncation = truncateHead(body, {
			maxBytes: bodyByteBudgets[index],
			maxLines: bodyLineBudgets[index],
		});
		const truncated = truncation.truncated;
		operationTruncated.push(truncated);
		return formatSection(prefixes[index], truncation.content, truncated);
	});
	let text = sections.join("\n\n");

	// The reservation above is intentionally conservative. Keep a final guard
	// for unusual UTF-8 or very small test limits without dropping any section.
	if (byteLength(text) > maxBytes || countLines(text) > maxLines) {
		text = fitAggregateText(text, maxBytes, maxLines);
	}

	return {
		text,
		truncated: operationTruncated.some(Boolean) || text !== completeText,
		originalOutputBytes,
		originalOutputLines,
		outputBytes: byteLength(text),
		outputLines: countLines(text),
		operationTruncated,
	};
}

export async function resolveSafeRepoPath(
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal);
	if (typeof rawPath !== "string" || rawPath.trim() === "") {
		throw new Error("Repository paths must be non-empty strings.");
	}

	const root = path.resolve(cwd);
	const rootRealPath = await fs.realpath(root);
	const normalizedPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const lexicalPath = path.resolve(root, normalizedPath || ".");
	if (!isWithinRoot(lexicalPath, root)) {
		throw new Error(`Path escapes the subagent working directory: ${rawPath}`);
	}

	let probe = lexicalPath;
	while (true) {
		throwIfAborted(signal);
		try {
			const realPath = await fs.realpath(probe);
			if (!isWithinRoot(realPath, rootRealPath)) {
				throw new Error(`Path resolves outside the subagent working directory: ${rawPath}`);
			}
			return lexicalPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
				throw error;
			}
			const parent = path.dirname(probe);
			if (parent === probe) return lexicalPath;
			probe = parent;
		}
	}
}

async function normalizeOperation(
	raw: Record<string, unknown>,
	kind: RepoQueryKind,
	id: string,
	root: string,
	signal?: AbortSignal,
): Promise<ResolvedRepoQueryOperation> {
	assertAllowedFields(raw, kind);

	switch (kind) {
		case "read": {
			const operation: ResolvedRepoQueryOperation = {
				id,
				kind,
				path: await resolveSafeRepoPath(requireString(raw.path, "read.path"), root, signal),
				limit: readLimit(raw.limit),
			};
			if (raw.offset !== undefined) operation.offset = positiveInteger(raw.offset, "read.offset");
			return operation;
		}
		case "grep": {
			return {
				id,
				kind,
				pattern: requireString(raw.pattern, "grep.pattern"),
				path: await resolveOptionalPath(raw.path, root, signal),
				glob: optionalString(raw.glob, "grep.glob"),
				ignoreCase: optionalBoolean(raw.ignoreCase, "grep.ignoreCase") ?? false,
				literal: optionalBoolean(raw.literal, "grep.literal") ?? false,
				context: boundedNonNegativeInteger(raw.context, "grep.context", REPO_QUERY_LIMITS.grepContext.default, REPO_QUERY_LIMITS.grepContext.maximum),
				limit: boundedInteger(raw.limit, "grep.limit", REPO_QUERY_LIMITS.grepMatches.default, REPO_QUERY_LIMITS.grepMatches.maximum),
			};
		}
		case "find":
			return {
				id,
				kind,
				pattern: requireString(raw.pattern, "find.pattern"),
				path: await resolveOptionalPath(raw.path, root, signal),
				limit: boundedInteger(raw.limit, "find.limit", REPO_QUERY_LIMITS.findResults.default, REPO_QUERY_LIMITS.findResults.maximum),
			};
		case "ls":
			return {
				id,
				kind,
				path: await resolveOptionalPath(raw.path, root, signal),
				limit: boundedInteger(raw.limit, "ls.limit", REPO_QUERY_LIMITS.lsEntries.default, REPO_QUERY_LIMITS.lsEntries.maximum),
			};
		case "files":
			return {
				id,
				kind,
				query: requireString(raw.query, "files.query"),
				includeHidden: optionalBoolean(raw.includeHidden, "files.includeHidden") ?? false,
				limit: boundedInteger(raw.limit, "files.limit", REPO_QUERY_LIMITS.fileResults.default, REPO_QUERY_LIMITS.fileResults.maximum),
			};
		case "git_status":
			return { id, kind };
		case "git_diff":
			return { id, kind, mode: requireDiffMode(raw.mode) };
	}
}

async function resolveOptionalPath(
	value: unknown,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	return resolveSafeRepoPath(value === undefined ? "." : requireString(value, "path"), cwd, signal);
}

async function runOperations(
	operations: ResolvedRepoQueryOperation[],
	signal: AbortSignal | undefined,
	executeOperation: RepoQueryOperationExecutor,
): Promise<RepoQueryOperationRecord[]> {
	const firstByKey = new Map<string, number>();
	const jobs: Array<{ index: number; operation: ResolvedRepoQueryOperation }> = [];
	const firstIndexForOperation: number[] = [];

	for (let index = 0; index < operations.length; index++) {
		const operation = operations[index];
		const key = operationKey(operation);
		const firstIndex = firstByKey.get(key);
		if (firstIndex === undefined) {
			firstByKey.set(key, index);
			firstIndexForOperation[index] = index;
			jobs.push({ index, operation });
		} else {
			firstIndexForOperation[index] = firstIndex;
		}
	}

	const firstRecords: Array<RepoQueryOperationRecord | undefined> = [];
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			throwIfAborted(signal);
			const job = jobs[cursor++];
			if (!job) return;
			firstRecords[job.index] = await runOneOperation(job.operation, signal, executeOperation);
		}
	};

	const workerCount = Math.min(REPO_QUERY_LIMITS.maxConcurrency, jobs.length);
	const workers = Array.from({ length: workerCount }, () => worker());
	const settled = await Promise.allSettled(workers);
	if (signal?.aborted) throw abortReason(signal);
	const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (rejected) throw rejected.reason;

	return operations.map((operation, index) => {
		const firstIndex = firstIndexForOperation[index];
		const first = firstRecords[firstIndex];
		if (!first) throw new Error(`repo_query operation ${operation.id} did not produce a result.`);
		if (firstIndex === index) return first;
		return {
			id: operation.id,
			kind: operation.kind,
			body: `Duplicate of ${oneLine(first.id)}.`,
			durationMs: 0,
			success: first.success,
			error: first.error,
			deduplicatedFrom: first.id,
		};
	});
}

async function runOneOperation(
	operation: ResolvedRepoQueryOperation,
	signal: AbortSignal | undefined,
	executeOperation: RepoQueryOperationExecutor,
): Promise<RepoQueryOperationRecord> {
	const startedAt = Date.now();
	try {
		const output = await awaitWithSignal(
			Promise.resolve().then(() => executeOperation(operation, signal)),
			signal,
		);
		throwIfAborted(signal);
		const body = typeof output === "string" ? output : output?.text ?? "";
		return {
			id: operation.id,
			kind: operation.kind,
			body,
			durationMs: Date.now() - startedAt,
			success: true,
		};
	} catch (error) {
		if (signal?.aborted) throw abortReason(signal);
		const message = error instanceof Error ? error.message : String(error);
		return {
			id: operation.id,
			kind: operation.kind,
			body: `Error: ${message}`,
			durationMs: Date.now() - startedAt,
			success: false,
			error: message,
		};
	}
}

function formatOperationPrefix(record: RepoQueryOperationRecord): string {
	const id = oneLine(record.id);
	if (record.deduplicatedFrom) {
		return `## ${id} [${record.kind}]\nstatus: duplicate of ${oneLine(record.deduplicatedFrom)} (${record.durationMs}ms)`;
	}
	return `## ${id} [${record.kind}]\nstatus: ${record.success ? "ok" : "error"} (${record.durationMs}ms)`;
}

function formatSection(prefix: string, body: string, truncated: boolean): string {
	let section = prefix;
	if (body) section += `\n${body}`;
	if (truncated) section += `\n${TRUNCATION_NOTICE}`;
	return section;
}

function allocateFair(needs: number[], total: number): number[] {
	const allocations = needs.map(() => 0);
	let remaining = Math.max(0, Math.floor(total));
	let active = needs.map((_, index) => index).filter((index) => needs[index] > 0);

	while (active.length > 0 && remaining > 0) {
		const share = Math.floor(remaining / active.length);
		const remainder = remaining % active.length;
		const next: number[] = [];
		for (let position = 0; position < active.length; position++) {
			const index = active[position];
			const allowance = share + (position < remainder ? 1 : 0);
			const wanted = needs[index] - allocations[index];
			const granted = Math.min(wanted, allowance);
			allocations[index] += granted;
			remaining -= granted;
			if (allocations[index] < needs[index]) next.push(index);
		}
		if (next.length === active.length && share === 0 && remainder === 0) break;
		active = next;
	}

	return allocations;
}

function fitAggregateText(text: string, maxBytes: number, maxLines: number): string {
	const truncation = truncateHead(text, { maxBytes, maxLines });
	if (!truncation.truncated) return text;
	return truncation.content;
}

function normalizeBody(value: string): string {
	return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
}

function countLines(value: string): number {
	if (!value) return 0;
	return value.split("\n").length;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function normalizeOutputLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("repo_query output limits must be positive integers.");
	return value;
}

function operationKey(operation: ResolvedRepoQueryOperation): string {
	const { id: _id, ...withoutId } = operation;
	return JSON.stringify(withoutId);
}

function resolveOperationId(
	value: unknown,
	usedIds: Set<string>,
	generate: () => string,
): string {
	if (value === undefined) return generate();
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error("repo_query operation IDs must be non-empty strings.");
	}
	const id = value.trim();
	if (usedIds.has(id)) throw new Error(`Duplicate repo_query operation ID: ${id}`);
	return id;
}

function requireKind(value: unknown): RepoQueryKind {
	if (typeof value !== "string" || !(REPO_QUERY_KINDS as readonly string[]).includes(value)) {
		throw new Error(`Unknown repo_query operation kind: ${String(value)}.`);
	}
	return value as RepoQueryKind;
}

function requireDiffMode(value: unknown): RepoQueryDiffMode {
	if (value !== "summary" && value !== "staged" && value !== "unstaged" && value !== "uncommitted") {
		throw new Error("git_diff.mode must be summary, staged, unstaged, or uncommitted.");
	}
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required.`);
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string.`);
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
	return value;
}

function positiveInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer.`);
	return value as number;
}

function boundedInteger(value: unknown, field: string, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	const parsed = positiveInteger(value, field);
	if (parsed > maximum) throw new Error(`${field} must be at most ${maximum}.`);
	return parsed;
}

function readLimit(value: unknown): number {
	return boundedInteger(value, "read.limit", REPO_QUERY_LIMITS.readLines.default, REPO_QUERY_LIMITS.readLines.maximum);
}

function boundedNonNegativeInteger(value: unknown, field: string, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer.`);
	const parsed = value as number;
	if (parsed > maximum) throw new Error(`${field} must be at most ${maximum}.`);
	return parsed;
}

function assertAllowedFields(raw: Record<string, unknown>, kind: RepoQueryKind): void {
	const allowed = new Set<string>(["id", "kind"]);
	switch (kind) {
		case "read":
			allowed.add("path").add("offset").add("limit");
			break;
		case "grep":
			for (const field of ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]) allowed.add(field);
			break;
		case "find":
			allowed.add("pattern").add("path").add("limit");
			break;
		case "ls":
			allowed.add("path").add("limit");
			break;
		case "files":
			allowed.add("query").add("includeHidden").add("limit");
			break;
		case "git_status":
			break;
		case "git_diff":
			allowed.add("mode");
			break;
	}
	for (const field of Object.keys(raw)) {
		if (!allowed.has(field)) throw new Error(`${field} is not valid for repo_query ${kind} operations.`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithinRoot(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative === ""
		|| (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function oneLine(value: string): string {
	const singleLine = value.replace(/[\r\n]+/g, " ");
	return singleLine.length > 200 ? `${singleLine.slice(0, 197)}...` : singleLine;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("repo_query aborted.", "AbortError");
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortReason(signal);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => finish(() => reject(abortReason(signal)));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}
