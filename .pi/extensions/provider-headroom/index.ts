import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerToolOutputRetention, type ToolOutputRetention } from "../_shared/tool-output-retention.ts";
import {
	CCR_ENTRY_TYPE,
	CCR_METADATA_KEY,
	PROTECTION_METADATA_KEY,
	RETRIEVE_TOOL_NAME,
	createToolOutputRetention,
	type HeadroomExtensionOptions,
	type ToolOutputRetentionHost,
} from "./tool-output-retention.ts";

export {
	CCR_ENTRY_TYPE,
	CCR_METADATA_KEY,
	PROTECTION_METADATA_KEY,
	RETRIEVE_TOOL_NAME,
	type HeadroomExtensionOptions,
} from "./tool-output-retention.ts";

type PiAgentMessage = ContextEvent["messages"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function latestUserQueryFromSession(ctx: { sessionManager: { buildContextEntries(): unknown[] } }): string {
	let latest = "";
	try {
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
			const text = textFromMessage(entry.message as unknown as PiAgentMessage);
			if (text) latest = text;
		}
	} catch {
		return "";
	}
	return latest.slice(-8_000);
}

function normalizedHash(hash: string): string {
	return hash.trim().replace(/^hash=/i, "").toLowerCase();
}

export function createHeadroomExtension(overrides: HeadroomExtensionOptions = {}) {
	return (pi: ExtensionAPI): void => {
		let retention: ToolOutputRetention | undefined;
		let unregisterRetention: (() => void) | undefined;

		const host: ToolOutputRetentionHost = {
			appendEntry(customType, data) {
				try {
					pi.appendEntry(customType, data);
				} catch {
					// Retention is optional and must not fail the provider request.
				}
			},
			setRetrievalAvailable(available) {
				try {
					const current = pi.getActiveTools();
					const next = available
						? [...new Set([...current, RETRIEVE_TOOL_NAME])]
						: current.filter((name) => name !== RETRIEVE_TOOL_NAME);
					if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
						pi.setActiveTools(next);
					}
				} catch {
					// Tool activation is best effort.
				}
			},
		};

		const clearRetention = (): void => {
			unregisterRetention?.();
			unregisterRetention = undefined;
			retention = undefined;
		};

		const rebuildRetention = (ctx: { sessionManager: { getBranch(): unknown[] } }): void => {
			clearRetention();
			let branch: unknown[] = [];
			try {
				branch = ctx.sessionManager.getBranch();
			} catch {
				// Start with an empty store rather than retaining stale branch state.
			}
			const next = createToolOutputRetention({ overrides, host, branch });
			retention = next;
			unregisterRetention = registerToolOutputRetention(next);
		};

		pi.registerTool({
			name: RETRIEVE_TOOL_NAME,
			label: "Headroom retrieve",
			description: "Retrieve the full original tool output identified by a Headroom hash marker.",
			parameters: Type.Object({
				hash: Type.String({ description: "The hash from a Headroom retrieval marker." }),
			}),
			async execute(_toolCallId, params) {
				const hash = normalizedHash(params.hash);
				const result = retention?.retrieve(hash) ?? { found: false as const, hash };
				if (!result.found) {
					return {
						content: [{ type: "text" as const, text: `No Headroom content is available for hash ${result.hash}.` }],
						details: { headroomRetrieve: true, hash: result.hash, found: false },
					};
				}
				return {
					content: [{ type: "text" as const, text: result.original }],
					details: { headroomRetrieve: true, hash: result.hash, found: true },
				};
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			rebuildRetention(ctx);
		});

		pi.on("session_tree", async (_event, ctx) => {
			rebuildRetention(ctx);
		});

		pi.on("session_shutdown", async () => {
			clearRetention();
		});

		pi.on("tool_result", async (event, ctx) => {
			if (!retention || event.toolName === RETRIEVE_TOOL_NAME) return;
			try {
				const rewritten = retention.rewriteFresh({
					toolName: event.toolName,
					input: event.input,
					isError: event.isError,
					content: event.content,
					details: event.details,
					query: latestUserQueryFromSession(ctx),
				});
				return rewritten.changed ? { content: rewritten.content, details: rewritten.details } : undefined;
			} catch {
				return undefined;
			}
		});

		pi.on("context", async (event) => {
			if (!retention) return;
			try {
				const projected = retention.projectHistory(event.messages);
				return projected.changed ? { messages: projected.messages } : undefined;
			} catch {
				return undefined;
			}
		});
	};
}

export default createHeadroomExtension();
