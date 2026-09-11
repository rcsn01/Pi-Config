import type { SessionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type RetentionMessage = SessionContext["messages"][number];
export type ToolResultContent = (TextContent | ImageContent)[];

export interface FreshToolOutput {
	toolName: string;
	input: Readonly<Record<string, unknown>>;
	isError: boolean;
	content: ToolResultContent;
	details: unknown;
}

export interface FreshToolOutputRewrite {
	changed: boolean;
	content: ToolResultContent;
	details: unknown;
}

export interface HistoryProjection {
	changed: boolean;
	messages: RetentionMessage[];
}

export type RetentionRetrieval =
	| { found: true; hash: string; original: string }
	| { found: false; hash: string };

export interface ToolOutputRetention {
	/** Raw material for the fresh query is supplied as live Session context entries. */
	rewriteFresh(input: FreshToolOutput, contextEntries: readonly unknown[]): FreshToolOutputRewrite;
	projectHistory(messages: readonly RetentionMessage[]): HistoryProjection;
	retrieve(hash: string): RetentionRetrieval;
}

const REGISTRY_KEY = Symbol.for("pi-config.tool-output-retention.v1");

interface ToolOutputRetentionRegistry {
	retention?: ToolOutputRetention;
}

function getRegistry(): ToolOutputRetentionRegistry {
	const globalRegistry = globalThis as typeof globalThis & {
		[REGISTRY_KEY]?: ToolOutputRetentionRegistry;
	};
	return globalRegistry[REGISTRY_KEY] ??= {};
}

export function registerToolOutputRetention(retention: ToolOutputRetention): () => void {
	getRegistry().retention = retention;
	return () => {
		const registry = getRegistry();
		if (registry.retention === retention) registry.retention = undefined;
	};
}

export function getToolOutputRetention(): ToolOutputRetention | undefined {
	return getRegistry().retention;
}

export function clearToolOutputRetention(): void {
	getRegistry().retention = undefined;
}
