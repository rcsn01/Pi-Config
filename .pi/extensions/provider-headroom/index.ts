import { createHash } from "node:crypto";
import type { ExtensionAPI, ContextEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	hasHeadroomMarker,
	looksLikeSourceCode,
	reduceToolOutput,
	type ReductionMode,
	type ReductionResult,
} from "./reducer.ts";

export const RETRIEVE_TOOL_NAME = "headroom_retrieve";
export const CCR_METADATA_KEY = "__headroom_ccr";
export const PROTECTION_METADATA_KEY = "__headroom_protected";
export const CCR_ENTRY_TYPE = "provider-headroom-ccr";

const DEFAULT_MIN_CHARS = 500;
const DEFAULT_MAX_LINES = 120;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_SEARCH_MATCHES = 40;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_DEDUPE_MIN_CHARS = 240;
const SMALL_ERROR_MAX_CHARS = 4_000;

const LOSSLESS_ONLY_TOOLS = new Set(["grep", "find", "ls"]);
const VERBATIM_TOOLS = new Set([
	"read",
	"write",
	"edit",
	"websearch",
	"webfetch",
	"web_search",
	"web_fetch",
	"headroom_retrieve",
]);
const READ_COMMAND_RE = /^(?:(?:cd\s+[^;&]+\s*&&\s*)?)(?:cat|head|tail|nl|less|more)\b|^(?:(?:cd\s+[^;&]+\s*&&\s*)?)sed\s+-n\b/i;

interface StoredCcrEntry {
	version: 1;
	hash: string;
	original: string;
	toolName: string;
	strategy: string;
	omitted: number;
	createdAt: number;
	blockIndex: number;
}

interface CcrMetadata {
	version: 1;
	entries: StoredCcrEntry[];
}

interface HeadroomConfig {
	enabled: boolean;
	ccr: boolean;
	dedupe: boolean;
	mode: ReductionMode;
	minChars: number;
	maxLines: number;
	maxItems: number;
	maxSearchMatches: number;
	maxChars: number;
	dedupeMinChars: number;
}

export interface HeadroomExtensionOptions {
	enabled?: boolean;
	ccr?: boolean;
	dedupe?: boolean;
	mode?: ReductionMode;
	minChars?: number;
	maxLines?: number;
	maxItems?: number;
	maxSearchMatches?: number;
	maxChars?: number;
	dedupeMinChars?: number;
}

type PiAgentMessage = ContextEvent["messages"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envBoolean(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function envPositiveInteger(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resolveConfig(overrides: HeadroomExtensionOptions): HeadroomConfig {
	const configuredMode = overrides.mode ?? process.env.PI_HEADROOM_MODE;
	const mode: ReductionMode = configuredMode === "lossless" ? "lossless" : "lossless_then_lossy";
	return {
		enabled: overrides.enabled ?? envBoolean("PI_HEADROOM_ENABLED", true),
		ccr: overrides.ccr ?? envBoolean("PI_HEADROOM_CCR", true),
		dedupe: overrides.dedupe ?? envBoolean("PI_HEADROOM_DEDUPE", true),
		mode,
		minChars: overrides.minChars ?? envPositiveInteger("PI_HEADROOM_MIN_CHARS", DEFAULT_MIN_CHARS),
		maxLines: overrides.maxLines ?? envPositiveInteger("PI_HEADROOM_MAX_LINES", DEFAULT_MAX_LINES),
		maxItems: overrides.maxItems ?? envPositiveInteger("PI_HEADROOM_MAX_ITEMS", DEFAULT_MAX_ITEMS),
		maxSearchMatches:
			overrides.maxSearchMatches ??
			envPositiveInteger("PI_HEADROOM_MAX_SEARCH_MATCHES", DEFAULT_MAX_SEARCH_MATCHES),
		maxChars: overrides.maxChars ?? envPositiveInteger("PI_HEADROOM_MAX_CHARS", DEFAULT_MAX_CHARS),
		dedupeMinChars:
			overrides.dedupeMinChars ?? envPositiveInteger("PI_HEADROOM_DEDUPE_MIN_CHARS", DEFAULT_DEDUPE_MIN_CHARS),
	};
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function textFromMessage(message: PiAgentMessage): string {
	if (message.role !== "user") return "";
	return textFromContent(message.content);
}

function latestUserQuery(messages: readonly PiAgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = textFromMessage(messages[index]!);
		if (text) return text.slice(-8_000);
	}
	return "";
}

function latestUserQueryFromSession(ctx: { sessionManager: { buildContextEntries(): unknown[] } }): string {
	let latest = "";
	try {
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
			const message = entry.message as unknown as PiAgentMessage;
			const text = textFromMessage(message);
			if (text) latest = text;
		}
	} catch {
		return "";
	}
	return latest.slice(-8_000);
}

function isToolResultMessage(message: PiAgentMessage): message is ToolResultMessage {
	return message.role === "toolResult";
}

function validStoredEntry(value: unknown): value is StoredCcrEntry {
	return (
		isRecord(value) &&
		value.version === 1 &&
		typeof value.hash === "string" &&
		/^[a-f0-9]{24}$/.test(value.hash) &&
		typeof value.original === "string" &&
		typeof value.toolName === "string" &&
		typeof value.strategy === "string" &&
		typeof value.omitted === "number" &&
		typeof value.createdAt === "number" &&
		typeof value.blockIndex === "number"
	);
}

function metadataEntries(details: unknown): StoredCcrEntry[] {
	if (!isRecord(details)) return [];
	const metadata = details[CCR_METADATA_KEY];
	if (!isRecord(metadata) || metadata.version !== 1 || !Array.isArray(metadata.entries)) return [];
	return metadata.entries.filter(validStoredEntry);
}

function hasProtectionHint(details: unknown): boolean {
	if (!isRecord(details)) return false;
	const hint = details[PROTECTION_METADATA_KEY];
	return isRecord(hint) && hint.version === 1 && hint.verbatim === true;
}

function addProtectionHint(details: unknown): unknown {
	if (hasProtectionHint(details)) return details;
	const hint = { version: 1, verbatim: true };
	if (isRecord(details)) return { ...details, [PROTECTION_METADATA_KEY]: hint };
	return {
		[PROTECTION_METADATA_KEY]: hint,
		...(details === undefined ? {} : { originalDetails: details }),
	};
}

function addMetadata(details: unknown, entries: StoredCcrEntry[]): unknown {
	const existing = metadataEntries(details);
	const byHash = new Map(existing.map((entry) => [entry.hash, entry]));
	for (const entry of entries) byHash.set(entry.hash, entry);
	const metadata: CcrMetadata = { version: 1, entries: [...byHash.values()] };
	if (isRecord(details)) return { ...details, [CCR_METADATA_KEY]: metadata };
	return {
		[CCR_METADATA_KEY]: metadata,
		...(details === undefined ? {} : { originalDetails: details }),
	};
}

class CcrStore {
	private readonly entries = new Map<string, StoredCcrEntry>();
	private readonly persisted = new Set<string>();

	create(original: string, toolName: string, strategy: string, omitted: number, blockIndex: number): StoredCcrEntry {
		return {
			version: 1,
			hash: hashText(original),
			original,
			toolName,
			strategy,
			omitted,
			createdAt: Date.now(),
			blockIndex,
		};
	}

	store(entry: StoredCcrEntry): void {
		this.entries.set(entry.hash, entry);
	}

	hydrate(value: unknown, persisted = false): void {
		if (!validStoredEntry(value)) return;
		this.entries.set(value.hash, value);
		if (persisted) this.persisted.add(value.hash);
	}

	get(hash: string): StoredCcrEntry | undefined {
		return this.entries.get(hash);
	}

	values(): StoredCcrEntry[] {
		return [...this.entries.values()];
	}

	markPersisted(hash: string): boolean {
		if (this.persisted.has(hash)) return false;
		this.persisted.add(hash);
		return true;
	}
}

function hydrateFromSession(store: CcrStore, ctx: { sessionManager: { getBranch(): unknown[] } }): void {
	let branch: unknown[];
	try {
		branch = ctx.sessionManager.getBranch();
	} catch {
		return;
	}

	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type === "custom" && entry.customType === CCR_ENTRY_TYPE) {
			store.hydrate(entry.data, true);
			continue;
		}
		if (entry.type === "message" && isRecord(entry.message)) {
			for (const metadata of metadataEntries(entry.message.details)) store.hydrate(metadata);
		}
	}
}

function persistCcrEntry(pi: ExtensionAPI, store: CcrStore, entry: StoredCcrEntry): void {
	if (!store.markPersisted(entry.hash)) return;
	try {
		pi.appendEntry(CCR_ENTRY_TYPE, entry);
	} catch {
		// CCR is an optimization. A session persistence failure must not break a tool result.
	}
}

function activateRetrievalTool(pi: ExtensionAPI, enabled: boolean): void {
	const current = pi.getActiveTools();
	const next = enabled
		? [...new Set([...current, RETRIEVE_TOOL_NAME])]
		: current.filter((name) => name !== RETRIEVE_TOOL_NAME);
	if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
		pi.setActiveTools(next);
	}
}

function isReadCommand(command: unknown): boolean {
	return typeof command === "string" && READ_COMMAND_RE.test(command.trim());
}

function isReadLikeTool(toolName: string): boolean {
	return toolName === "read" || /(?:^|[_-])read(?:$|[_-])/.test(toolName) || /(?:^|[_-])file[_-]?read$/.test(toolName);
}

function toolPolicy(
	toolName: string,
	input: Record<string, unknown>,
	text: string,
	isError: boolean,
): { protected: boolean; allowLossy: boolean } {
	const normalized = toolName.trim().toLowerCase();
	if (VERBATIM_TOOLS.has(normalized) || isReadLikeTool(normalized)) return { protected: true, allowLossy: false };
	if (LOSSLESS_ONLY_TOOLS.has(normalized)) return { protected: false, allowLossy: false };
	if (isError && text.length <= SMALL_ERROR_MAX_CHARS) return { protected: true, allowLossy: false };

	if ((normalized === "bash" || normalized === "powershell") && (isReadCommand(input.command) || looksLikeSourceCode(text))) {
		return { protected: true, allowLossy: false };
	}
	return { protected: false, allowLossy: true };
}

function jsonMarker(text: string, hash: string): string | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (!Array.isArray(value)) return undefined;
		const sentinel = value.find(
			(item): item is Record<string, unknown> => isRecord(item) && typeof item._headroom_omitted === "number",
		);
		if (!sentinel) return undefined;
		sentinel._headroom_retrieve = hash;
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

function lossDescription(result: ReductionResult): string {
	if (result.kind === "json") return `${result.omitted} JSON items`;
	if (result.kind === "search") return `${result.omitted} search matches`;
	return `${result.omitted} ${result.kind} lines`;
}

function decorateLossy(result: ReductionResult, entry: StoredCcrEntry | undefined, ccr: boolean): string {
	if (!result.lossyChanged) return result.text;
	if (ccr && entry) {
		const markedJson = result.kind === "json" ? jsonMarker(result.text, entry.hash) : undefined;
		if (markedJson) return markedJson;
		return `${result.text}\n[Headroom omitted ${lossDescription(result)}. Retrieve original: hash=${entry.hash}]`;
	}
	return `${result.text}\n[Headroom omitted ${lossDescription(result)}.]`;
}

interface RewrittenText {
	text: string;
	changed: boolean;
	lossy: boolean;
	entry?: StoredCcrEntry;
}

function rewriteText(
	text: string,
	toolName: string,
	input: Record<string, unknown>,
	isError: boolean,
	blockIndex: number,
	query: string,
	config: HeadroomConfig,
	store: CcrStore,
	persist: (entry: StoredCcrEntry) => void,
): RewrittenText {
	if (!text || text.length < config.minChars || hasHeadroomMarker(text)) {
		return { text, changed: false, lossy: false };
	}

	const policy = toolPolicy(toolName, input, text, isError);
	if (policy.protected) return { text, changed: false, lossy: false };

	const result = reduceToolOutput(text, {
		mode: policy.allowLossy ? config.mode : "lossless",
		allowLossy: policy.allowLossy,
		maxLines: config.maxLines,
		maxItems: config.maxItems,
		maxSearchMatches: config.maxSearchMatches,
		maxChars: config.maxChars,
		query,
	});
	if (!result.changed) return { text, changed: false, lossy: false };

	if (!result.lossyChanged) return { text: result.text, changed: true, lossy: false };

	const entry = config.ccr ? store.create(text, toolName, result.strategy, result.omitted, blockIndex) : undefined;
	const decorated = decorateLossy(result, entry, config.ccr);
	if (decorated.length >= text.length) {
		// A marker can erase a marginal saving. Keep only a safe lossless fold in that case.
		const lossless = reduceToolOutput(text, {
			mode: "lossless",
			allowLossy: false,
			maxLines: config.maxLines,
			maxItems: config.maxItems,
			maxSearchMatches: config.maxSearchMatches,
			maxChars: config.maxChars,
			query,
		});
		return lossless.changed
			? { text: lossless.text, changed: true, lossy: false }
			: { text, changed: false, lossy: false };
	}

	if (entry) {
		store.store(entry);
		persist(entry);
	}
	return { text: decorated, changed: true, lossy: true, entry };
}

function contentWithTextBlock(content: ToolResultEvent["content"], blockIndex: number, text: string): ToolResultEvent["content"] {
	return content.map((block, index) => (index === blockIndex && block.type === "text" ? { ...block, text } : block));
}

function rewriteFreshResult(
	event: ToolResultEvent,
	query: string,
	config: HeadroomConfig,
	store: CcrStore,
): { content: ToolResultEvent["content"]; details: unknown; changed: boolean; hasCcr: boolean } {
	let content = event.content;
	const entries: StoredCcrEntry[] = [];
	let changed = false;
	let hasCcr = false;
	const isReadCommandResult =
		(event.toolName === "bash" || event.toolName === "powershell") && isReadCommand(event.input.command);
	const protectedDetails = isReadCommandResult ? addProtectionHint(event.details) : event.details;

	for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
		const block = content[blockIndex];
		if (block?.type !== "text") continue;
		const rewritten = rewriteText(
			block.text,
			event.toolName,
			event.input,
			event.isError,
			blockIndex,
			query,
			config,
			store,
			() => {},
		);
		if (!rewritten.changed) continue;
		content = contentWithTextBlock(content, blockIndex, rewritten.text);
		changed = true;
		if (rewritten.entry) {
			entries.push(rewritten.entry);
			hasCcr = true;
		}
	}

	const details = entries.length > 0 ? addMetadata(protectedDetails, entries) : protectedDetails;
	if (!changed && details === event.details) return { content, details, changed: false, hasCcr: false };
	return {
		content,
		details,
		changed: true,
		hasCcr,
	};
}

function messageMetadataByBlock(message: ToolResultMessage): Map<number, StoredCcrEntry> {
	return new Map(metadataEntries(message.details).map((entry) => [entry.blockIndex, entry]));
}

function rewriteContext(
	event: ContextEvent,
	query: string,
	config: HeadroomConfig,
	store: CcrStore,
	pi: ExtensionAPI,
): { messages: PiAgentMessage[]; changed: boolean; hasCcr: boolean } {
	const seenExact = new Map<string, number>();
	let changed = false;
	let hasCcr = false;
	const messages = event.messages.map((message, messageIndex) => {
		if (!isToolResultMessage(message)) return message;
		const metadata = messageMetadataByBlock(message);
		for (const entry of metadata.values()) store.hydrate(entry);
		const protectedMessage = hasProtectionHint(message.details);

		let content = message.content;
		let messageChanged = false;
		for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
			const block = content[blockIndex];
			if (block?.type !== "text") continue;
			if (protectedMessage || metadata.has(blockIndex)) {
				if (metadata.has(blockIndex)) hasCcr = true;
				continue;
			}
			const rewritten = rewriteText(
				block.text,
				message.toolName,
				{},
				message.isError,
				blockIndex,
				query,
				config,
				store,
				(entry) => persistCcrEntry(pi, store, entry),
			);
			if (!rewritten.changed) continue;
			content = contentWithTextBlock(content, blockIndex, rewritten.text);
			messageChanged = true;
			if (rewritten.entry) hasCcr = true;
		}

		// Cross-turn dedup only replaces a complete, still-verbatim eligible block.
		// Protected reads and other excluded outputs must remain byte-exact even when
		// the same result appears more than once.
		const dedupePolicy = toolPolicy(message.toolName, {}, content[0]?.type === "text" ? content[0].text : "", message.isError);
		const dedupeAllowed = !protectedMessage && dedupePolicy.allowLossy && !dedupePolicy.protected;
		if (config.dedupe && dedupeAllowed && content.length === 1 && content[0]?.type === "text" && !metadata.has(0)) {
			const currentText = content[0].text;
			if (currentText.length >= config.dedupeMinChars && !hasHeadroomMarker(currentText)) {
				const key = hashText(currentText);
				if (seenExact.has(key)) {
					content = [{ ...content[0], text: "[Headroom: identical to an earlier tool result above.]" }];
					messageChanged = true;
				} else if (!messageChanged) {
					seenExact.set(key, messageIndex);
				}
			}
		}

		if (!messageChanged) return message;
		changed = true;
		return { ...message, content };
	});
	return { messages, changed, hasCcr };
}

export function createHeadroomExtension(overrides: HeadroomExtensionOptions = {}) {
	return (pi: ExtensionAPI): void => {
		const store = new CcrStore();

		pi.registerTool({
			name: RETRIEVE_TOOL_NAME,
			label: "Headroom retrieve",
			description: "Retrieve the full original tool output identified by a Headroom hash marker.",
			parameters: Type.Object({
				hash: Type.String({ description: "The hash from a Headroom retrieval marker." }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				hydrateFromSession(store, ctx);
				const hash = params.hash.trim().replace(/^hash=/i, "").toLowerCase();
				const entry = store.get(hash);
				if (!entry) {
					return {
						content: [{ type: "text", text: `No Headroom content is available for hash ${hash}.` }],
						details: { headroomRetrieve: true, hash, found: false },
					};
				}
				return {
					content: [{ type: "text", text: entry.original }],
					details: { headroomRetrieve: true, hash, found: true },
				};
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			hydrateFromSession(store, ctx);
			const config = resolveConfig(overrides);
			activateRetrievalTool(pi, config.enabled && config.ccr && store.values().length > 0);
		});

		pi.on("tool_result", async (event, ctx) => {
			const config = resolveConfig(overrides);
			if (!config.enabled || event.toolName === RETRIEVE_TOOL_NAME) return;
			const query = latestUserQueryFromSession(ctx);
			const rewritten = rewriteFreshResult(event, query, config, store);
			if (!rewritten.changed) return;
			if (rewritten.hasCcr) activateRetrievalTool(pi, true);
			return {
				content: rewritten.content,
				details: rewritten.details,
			};
		});

		pi.on("context", async (event, _ctx) => {
			const config = resolveConfig(overrides);
			if (!config.enabled) return;
			const query = latestUserQuery(event.messages);
			const rewritten = rewriteContext(event, query, config, store, pi);
			if (rewritten.hasCcr && config.ccr) activateRetrievalTool(pi, true);
			return rewritten.changed ? { messages: rewritten.messages } : undefined;
		});
	};
}

export default createHeadroomExtension();
