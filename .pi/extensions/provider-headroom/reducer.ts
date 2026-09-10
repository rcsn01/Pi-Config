export type ReductionMode = "lossless" | "lossless_then_lossy";

export type ReductionKind = "json" | "search" | "log" | "text" | "code";

export interface ReductionOptions {
	mode?: ReductionMode;
	allowLossy?: boolean;
	maxLines?: number;
	maxItems?: number;
	maxSearchMatches?: number;
	maxChars?: number;
	query?: string;
}

export interface ReductionResult {
	text: string;
	kind: ReductionKind;
	strategy: string;
	changed: boolean;
	losslessChanged: boolean;
	lossyChanged: boolean;
	omitted: number;
}

interface SearchRow {
	path: string;
	line: number;
	content: string;
}

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LOG_SIGNAL_RE =
	/(?:\b(?:trace|debug|info|notice|warn(?:ing)?|error|fatal|panic|fail(?:ed|ure)?|exception|critical)\b|\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/i;
const IMPORTANT_LINE_RE =
	/\b(?:error|fatal|panic|fail(?:ed|ure)?|exception|traceback|stack trace|warning|warn|critical|assert)\b/i;
const SEARCH_ROW_RE = /^(.*):(\d+):(.*)$/;
const CODE_FENCE_RE = /^\s*```/m;
const CODE_KEYWORD_RE =
	/\b(?:import|export|from|function|class|interface|type|const|let|var|def|async|await|return|package|func|fn|struct|impl|public|private)\b/;
const CODE_PUNCTUATION_RE = /[{};][ \t]*(?:$|\/\/|#)/;

const DEFAULT_MAX_LINES = 120;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_SEARCH_MATCHES = 40;
const DEFAULT_MAX_CHARS = 12_000;

function unchanged(text: string, kind: ReductionKind, strategy = "passthrough"): ReductionResult {
	return {
		text,
		kind,
		strategy,
		changed: false,
		losslessChanged: false,
		lossyChanged: false,
		omitted: 0,
	};
}

function termsFromQuery(query: string | undefined): string[] {
	if (!query) return [];
	return [...new Set(query.toLowerCase().split(/[^a-z0-9_$./-]+/).filter((term) => term.length >= 3))].slice(0, 32);
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function collapseBlankRuns(text: string): string {
	const lines = text.split("\n");
	const output: string[] = [];
	let previousWasBlank = false;

	for (const line of lines) {
		const blank = line.trim().length === 0;
		if (blank && previousWasBlank) continue;
		output.push(line);
		previousWasBlank = blank;
	}

	return output.join("\n");
}

function collapseRepeatedLines(text: string): string {
	const lines = text.split("\n");
	const output: string[] = [];

	for (let index = 0; index < lines.length; ) {
		let end = index + 1;
		while (end < lines.length && lines[end] === lines[index]) end++;
		const count = end - index;
		if (count >= 2 && lines[index].trim().length > 0) {
			output.push(lines[index], `... (repeated ${count} times)`);
		} else {
			output.push(...lines.slice(index, end));
		}
		index = end;
	}

	return output.join("\n");
}

function parseSearchRows(text: string): SearchRow[] | undefined {
	const lines = text.split("\n");
	const rows: SearchRow[] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim().length === 0) continue;
		const match = SEARCH_ROW_RE.exec(line);
		if (!match || !match[1]) return undefined;
		rows.push({
			path: match[1]!,
			line: Number(match[2]),
			content: match[3]!,
		});
	}

	if (rows.length < 3) return undefined;
	const distinctPaths = new Set(rows.map((row) => row.path));
	if (distinctPaths.size === 1 && rows.length < 5) return undefined;
	return rows;
}

function isLikelyCode(text: string): boolean {
	if (CODE_FENCE_RE.test(text)) return true;
	try {
		JSON.parse(text);
		return false;
	} catch {
		// Continue with source-shape checks.
	}

	const lines = text.split("\n");
	let signals = 0;
	for (const line of lines) {
		if (CODE_KEYWORD_RE.test(line)) signals++;
		if (CODE_PUNCTUATION_RE.test(line)) signals++;
		if (signals >= 3) return true;
	}
	return false;
}

function detectKind(text: string): { kind: ReductionKind; parsedJson?: unknown; searchRows?: SearchRow[] } {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return { kind: "json", parsedJson: JSON.parse(trimmed) };
		} catch {
			// A partial JSON response is handled as text or logs below.
		}
	}

	const searchRows = parseSearchRows(text);
	if (searchRows) return { kind: "search", searchRows };
	if (LOG_SIGNAL_RE.test(text)) return { kind: "log" };
	if (isLikelyCode(text)) return { kind: "code" };
	return { kind: "text" };
}

function losslessText(text: string, kind: ReductionKind, searchRows?: SearchRow[]): string {
	if (kind === "code") return text;
	if (kind === "search" && searchRows) {
		const candidate = renderSearchRows(searchRows);
		return candidate.length < text.length ? candidate : text;
	}

	let candidate = stripAnsi(text);
	candidate = collapseRepeatedLines(candidate);
	candidate = collapseBlankRuns(candidate);
	return candidate.length < text.length ? candidate : text;
}

function itemText(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function isImportantItem(value: unknown, queryTerms: string[]): boolean {
	const lower = itemText(value).toLowerCase();
	if (IMPORTANT_LINE_RE.test(lower)) return true;
	return queryTerms.some((term) => lower.includes(term));
}

function chooseJsonItems(items: unknown[], maxItems: number, query: string | undefined): number[] {
	if (items.length <= maxItems) return items.map((_item, index) => index);

	const queryTerms = termsFromQuery(query);
	const selected = new Set<number>();
	const boundaryCount = Math.max(1, Math.floor(maxItems * 0.25));
	for (let index = 0; index < boundaryCount; index++) selected.add(index);
	for (let index = Math.max(0, items.length - boundaryCount); index < items.length; index++) selected.add(index);

	// Keep every error/priority item. If there are many of them, this intentionally
	// wins over the soft max. Dropping every error to honor a hard count is unsafe.
	for (let index = 0; index < items.length; index++) {
		if (isImportantItem(items[index], queryTerms)) selected.add(index);
	}

	if (selected.size < maxItems) {
		const step = items.length / maxItems;
		for (let slot = 0; slot < maxItems && selected.size < maxItems; slot++) {
			selected.add(Math.min(items.length - 1, Math.floor(slot * step)));
		}
	}

	return [...selected].sort((left, right) => left - right);
}

function reduceJson(
	original: string,
	value: unknown,
	base: string,
	options: ReductionOptions,
): ReductionResult {
	if (!Array.isArray(value) || options.allowLossy === false || options.mode === "lossless") {
		return {
			text: base,
			kind: "json",
			strategy: base === original ? "json_passthrough" : "json_minify",
			changed: base !== original,
			losslessChanged: base !== original,
			lossyChanged: false,
			omitted: 0,
		};
	}

	const maxItems = Math.max(4, options.maxItems ?? DEFAULT_MAX_ITEMS);
	if (value.length <= maxItems) {
		return {
			text: base,
			kind: "json",
			strategy: base === original ? "json_passthrough" : "json_minify",
			changed: base !== original,
			losslessChanged: base !== original,
			lossyChanged: false,
			omitted: 0,
		};
	}

	const selected = chooseJsonItems(value, maxItems, options.query);
	if (selected.length >= value.length) {
		return {
			text: base,
			kind: "json",
			strategy: base === original ? "json_passthrough" : "json_minify",
			changed: base !== original,
			losslessChanged: base !== original,
			lossyChanged: false,
			omitted: 0,
		};
	}

	const omitted = value.length - selected.length;
	const reduced = selected.map((index) => value[index]);
	reduced.push({ _headroom_omitted: omitted });
	const lossyText = JSON.stringify(reduced);
	if (lossyText.length >= base.length) {
		return {
			text: base,
			kind: "json",
			strategy: base === original ? "json_passthrough" : "json_minify",
			changed: base !== original,
			losslessChanged: base !== original,
			lossyChanged: false,
			omitted: 0,
		};
	}

	return {
		text: lossyText,
		kind: "json",
		strategy: "json_sample",
		changed: true,
		losslessChanged: base !== original,
		lossyChanged: true,
		omitted,
	};
}

function renderSearchRows(rows: SearchRow[]): string {
	const groups = new Map<string, SearchRow[]>();
	for (const row of rows) {
		const group = groups.get(row.path) ?? [];
		group.push(row);
		groups.set(row.path, group);
	}
	const output: string[] = [];
	for (const [path, group] of groups) {
		if (output.length > 0) output.push("");
		output.push(`${path}:`);
		output.push(...group.map((row) => `${row.line}:${row.content}`));
	}
	return output.join("\n");
}

function searchRowScore(row: SearchRow, queryTerms: string[], index: number, total: number): number {
	return lineScore(`${row.path}:${row.line}:${row.content}`, queryTerms, index, total);
}

function chooseSearchRows(rows: SearchRow[], maxMatches: number, query: string | undefined): SearchRow[] {
	if (rows.length <= maxMatches) return rows;
	const terms = termsFromQuery(query);
	const selected = new Set<number>();
	const groups = new Map<string, number[]>();
	for (let index = 0; index < rows.length; index++) {
		const indexes = groups.get(rows[index]!.path) ?? [];
		indexes.push(index);
		groups.set(rows[index]!.path, indexes);
	}
	for (const indexes of groups.values()) {
		selected.add(indexes[0]!);
		selected.add(indexes.at(-1)!);
	}
	for (let index = 0; index < rows.length; index++) {
		if (IMPORTANT_LINE_RE.test(rows[index]!.content) || terms.some((term) => rows[index]!.content.toLowerCase().includes(term))) {
			selected.add(index);
		}
	}
	const ranked = rows
		.map((row, index) => ({ index, score: searchRowScore(row, terms, index, rows.length) }))
		.sort((left, right) => right.score - left.score || left.index - right.index);
	for (const candidate of ranked) {
		if (selected.size >= maxMatches) break;
		selected.add(candidate.index);
	}
	return [...selected]
		.sort((left, right) => left - right)
		.map((index) => rows[index]!);
}

function reduceSearch(
	original: string,
	base: string,
	rows: SearchRow[],
	options: ReductionOptions,
): ReductionResult {
	const limit = Math.max(1, options.maxSearchMatches ?? DEFAULT_MAX_SEARCH_MATCHES);
	if (rows.length <= limit || options.allowLossy === false || options.mode === "lossless") {
		return {
			text: base,
			kind: "search",
			strategy: base === original ? "search_passthrough" : "search_lossless",
			changed: base !== original,
			losslessChanged: base !== original,
			lossyChanged: false,
			omitted: 0,
		};
	}
	const selected = chooseSearchRows(rows, limit, options.query);
	const omitted = rows.length - selected.length;
	const lossyText = renderSearchRows(selected);
	if (lossyText.length >= base.length) {
		return {
			text: base,
			kind: "search",
			strategy: base === original ? "search_passthrough" : "search_lossless",
			changed: base !== original,
			losslessChanged: base !== original,
			lossyChanged: false,
			omitted: 0,
		};
	}
	return {
		text: lossyText,
		kind: "search",
		strategy: "search_sample",
		changed: true,
		losslessChanged: base !== original,
		lossyChanged: true,
		omitted,
	};
}

function lineScore(line: string, queryTerms: string[], index: number, total: number): number {
	let score = 0;
	if (IMPORTANT_LINE_RE.test(line)) score += 10;
	const lower = line.toLowerCase();
	for (const term of queryTerms) {
		if (lower.includes(term)) score += 3;
	}
	if (index < 3 || index >= total - 3) score += 2;
	return score;
}

function selectLines(lines: string[], maxLines: number, query: string | undefined): number[] {
	if (lines.length <= maxLines) return lines.map((_line, index) => index);
	const terms = termsFromQuery(query);
	const selected = new Set<number>();
	const boundaryCount = Math.max(2, Math.floor(maxLines * 0.1));

	// Priority lines are mandatory. The configured limit is soft when honoring it
	// would remove every error or warning from the result.
	for (let index = 0; index < lines.length; index++) {
		if (IMPORTANT_LINE_RE.test(lines[index]!)) selected.add(index);
	}
	for (let index = 0; index < boundaryCount && selected.size < maxLines; index++) selected.add(index);
	for (let index = Math.max(0, lines.length - boundaryCount); index < lines.length && selected.size < maxLines; index++) {
		selected.add(index);
	}

	const ranked = lines
		.map((line, index) => ({ index, score: lineScore(line, terms, index, lines.length) }))
		.sort((left, right) => right.score - left.score || left.index - right.index);
	for (const candidate of ranked) {
		if (selected.size >= maxLines) break;
		selected.add(candidate.index);
	}

	// Keep one line of context around important lines when room remains.
	for (const index of [...selected].sort((left, right) => left - right)) {
		if (selected.size >= maxLines) break;
		if (!IMPORTANT_LINE_RE.test(lines[index]!)) continue;
		if (index > 0) selected.add(index - 1);
		if (selected.size < maxLines && index + 1 < lines.length) selected.add(index + 1);
	}
	return [...selected].sort((left, right) => left - right);
}

function formatSelectedLines(lines: string[], selected: number[], omitted: number): string {
	const output: string[] = [];
	let previous = -1;
	for (const index of selected) {
		if (previous >= 0 && index > previous + 1) {
			output.push(`... (${index - previous - 1} lines omitted)`);
		}
		output.push(lines[index]!);
		previous = index;
	}
	if (omitted > 0 && output.length === 0) output.push(`... (${omitted} lines omitted)`);
	return output.join("\n");
}

function reduceLines(
	original: string,
	base: string,
	kind: "search" | "log" | "text",
	options: ReductionOptions,
): ReductionResult {
	const lines = base.split("\n");
	const limit = kind === "search" ? options.maxSearchMatches ?? DEFAULT_MAX_SEARCH_MATCHES : options.maxLines ?? DEFAULT_MAX_LINES;
	const tooLong = lines.length > limit || base.length > (options.maxChars ?? DEFAULT_MAX_CHARS);
	if (!tooLong || options.allowLossy === false || options.mode === "lossless") {
		return {
			text: base,
			kind,
			strategy: base === original ? `${kind}_passthrough` : `${kind}_lossless`,
			changed: base !== original,
			losslessChanged: base !== original,
			lossyChanged: false,
			omitted: 0,
		};
	}

	const selected = selectLines(lines, limit, options.query);
	const omitted = lines.length - selected.length;
	const lossyText = formatSelectedLines(lines, selected, omitted);
	if (lossyText.length >= base.length) {
		return {
			text: base,
			kind,
			strategy: base === original ? `${kind}_passthrough` : `${kind}_lossless`,
			changed: base !== original,
			losslessChanged: base !== original,
			lossyChanged: false,
			omitted: 0,
		};
	}

	return {
		text: lossyText,
		kind,
		strategy: `${kind}_sample`,
		changed: true,
		losslessChanged: base !== original,
		lossyChanged: true,
		omitted,
	};
}

export function reduceToolOutput(text: string, options: ReductionOptions = {}): ReductionResult {
	if (!text || text.trim().length === 0) return unchanged(text, "text");

	const detected = detectKind(text);
	if (detected.kind === "code") return unchanged(text, "code", "code_protected");

	const base =
		detected.kind === "json"
			? (() => {
				const compact = JSON.stringify(detected.parsedJson);
				return compact && compact.length < text.length ? compact : text;
			})()
			: losslessText(text, detected.kind, detected.searchRows);
	if (detected.kind === "json") {
		return reduceJson(text, detected.parsedJson, base, options);
	}
	if (detected.kind === "search" && detected.searchRows) {
		return reduceSearch(text, base, detected.searchRows, options);
	}
	return reduceLines(text, base, detected.kind, options);
}

export function looksLikeSourceCode(text: string): boolean {
	return isLikelyCode(text);
}

export function hasHeadroomMarker(text: string): boolean {
	return (
		/\[headroom[^\]]*(?:omitted|repeated|retrieve|identical)[^\]]*\]|<<headroom:[^>]+>>|_headroom_retrieve|retrieve original:\s*hash=/i.test(
			text,
		)
	);
}
