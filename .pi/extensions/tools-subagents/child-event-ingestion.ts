import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type {
	AgentProgress,
	AgentResult,
	AgentThinkingLevel,
	RunSubagentOptions,
	SubagentProgressEvent,
} from "../_shared/subagent-service.ts";
import { formatToolArgsPreview } from "./formatting.ts";
import { createSubagentTimingRecorder } from "./subagent-timing.ts";

export interface SubagentChildEventIngestionOptions {
	agentName: string;
	task: string;
	model: string;
	thinkingLevel?: AgentThinkingLevel;
	maxOutputBytes?: number;
	onUpdate?: RunSubagentOptions["onUpdate"];
	onProgress?: RunSubagentOptions["onProgress"];
}

export interface SubagentChildProcessOutcome {
	exitCode: number;
	stderr: string;
	processError?: string;
}

export interface SubagentChildEventIngestion {
	write(chunk: string | Buffer): void;
	finish(outcome: SubagentChildProcessOutcome): Promise<AgentResult>;
}

function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text?: unknown } => isRecord(part) && part.type === "text")
			.map((part) => part.text)
			.filter((text): text is string => typeof text === "string")
			.join("\n");
	}
	return "";
}

function createThrottle(fn: () => void, ms: number): { fire(): void; cancel(): void } {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		fire() {
			const now = Date.now();
			const remaining = ms - (now - lastCall);
			if (remaining <= 0) {
				lastCall = now;
				if (timer) clearTimeout(timer);
				timer = undefined;
				fn();
			} else if (!timer) {
				timer = setTimeout(() => {
					lastCall = Date.now();
					timer = undefined;
					fn();
				}, remaining);
			}
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

export function createSubagentChildEventIngestion(
	options: SubagentChildEventIngestionOptions,
): SubagentChildEventIngestion {
	const result: AgentResult = {
		agent: options.agentName,
		task: options.task,
		output: "",
		exitCode: 0,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			agent: options.agentName,
			status: "running",
			task: options.task,
			recentTools: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			lastMessage: "",
		},
	};
	const progress = result.progress;
	const startedAt = Date.now();
	const timing = createSubagentTimingRecorder();
	let buffer = "";
	let lastTool: string | undefined;
	let lastToolArgs: string | undefined;
	let recentToolCount = 0;
	let lastMessage = "";
	let streamedText = "";

	const emitProgress = (event: SubagentProgressEvent): void => {
		void options.onProgress?.(event, progress);
	};
	const updateThrottle = createThrottle(() => {
		progress.durationMs = Date.now() - startedAt;
		options.onUpdate?.(progress);
	}, 150);

	const recordAssistantText = (content: unknown): void => {
		const text = extractTextFromContent(content);
		if (!text) return;
		result.output = text;
		const proseLines: string[] = [];
		let inCodeBlock = false;
		for (const line of text.split("\n")) {
			if (line.trimStart().startsWith("```")) {
				inCodeBlock = !inCodeBlock;
				continue;
			}
			if (!inCodeBlock && line.trim()) proseLines.push(line.trim());
		}
		if (proseLines.length === 0) return;
		progress.lastMessage = proseLines.slice(0, 3).join(" ");
		if (progress.lastMessage !== lastMessage) {
			lastMessage = progress.lastMessage;
			emitProgress({ type: "message", agent: options.agentName, message: lastMessage, tokens: progress.tokens });
		}
	};

	const processEvent = (event: unknown): void => {
		timing.recordEvent(event);
		progress.durationMs = Date.now() - startedAt;
		if (!isRecord(event)) return;

		if (event.type === "tool_execution_start") {
			progress.toolCount++;
			progress.currentTool = typeof event.toolName === "string" ? event.toolName : undefined;
			progress.currentToolArgs = formatToolArgsPreview((event.args || {}) as Record<string, unknown>);
			if (progress.currentTool && (progress.currentTool !== lastTool || progress.currentToolArgs !== lastToolArgs)) {
				lastTool = progress.currentTool;
				lastToolArgs = progress.currentToolArgs;
				emitProgress({
					type: "tool_call",
					agent: options.agentName,
					tool: progress.currentTool,
					args: progress.currentToolArgs,
				});
			}
			updateThrottle.fire();
		}
		if (event.type === "tool_execution_end") {
			if (progress.currentTool) {
				progress.recentTools.push({ tool: progress.currentTool, args: progress.currentToolArgs || "" });
				for (const tool of progress.recentTools.slice(recentToolCount)) {
					emitProgress({ type: "tool_result", agent: options.agentName, tool: tool.tool, args: tool.args });
				}
				recentToolCount = progress.recentTools.length;
				if (progress.recentTools.length > 20) {
					progress.recentTools.splice(0, progress.recentTools.length - 20);
					recentToolCount = Math.min(recentToolCount, progress.recentTools.length);
				}
			}
			progress.currentTool = undefined;
			progress.currentToolArgs = undefined;
			updateThrottle.fire();
		}
		if (event.type === "tool_result_end") updateThrottle.fire();
		if (event.type === "message_start" && isRecord(event.message) && event.message.role === "assistant") streamedText = "";
		if (event.type === "message_update") {
			if (isRecord(event.message) && event.message.role === "assistant") {
				recordAssistantText(event.message.content);
				if (typeof event.message.errorMessage === "string" && event.message.errorMessage) {
					progress.error = event.message.errorMessage;
				}
			} else if (
				isRecord(event.assistantMessageEvent)
				&& event.assistantMessageEvent.type === "text_delta"
				&& typeof event.assistantMessageEvent.delta === "string"
			) {
				streamedText += event.assistantMessageEvent.delta;
				recordAssistantText(streamedText);
			}
			updateThrottle.fire();
		}
		if (event.type === "message_end" && isRecord(event.message)) {
			if (event.message.role === "assistant") {
				result.usage.turns++;
				if (isRecord(event.message.usage)) {
					result.usage.input += numberOrZero(event.message.usage.input);
					result.usage.output += numberOrZero(event.message.usage.output);
					result.usage.cacheRead += numberOrZero(event.message.usage.cacheRead);
					result.usage.cacheWrite += numberOrZero(event.message.usage.cacheWrite);
					result.usage.cost += isRecord(event.message.usage.cost) ? numberOrZero(event.message.usage.cost.total) : 0;
				}
				progress.tokens = result.usage.input + result.usage.output;
				if (typeof event.message.model === "string" && event.message.model) result.model = event.message.model;
				if (typeof event.message.errorMessage === "string" && event.message.errorMessage) {
					progress.error = event.message.errorMessage;
				}
				recordAssistantText(event.message.content);
			}
			updateThrottle.fire();
		}
	};

	const processLine = (line: string): void => {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		try {
			processEvent(event);
		} catch {}
	};

	return {
		write(chunk) {
			buffer += typeof chunk === "string" ? chunk : chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		},
		async finish(outcome) {
			if (buffer.trim()) processLine(buffer);
			buffer = "";
			updateThrottle.cancel();

			result.exitCode = outcome.exitCode;
			result.timing = timing.finish();
			if (!progress.error) {
				if (outcome.processError) progress.error = outcome.processError;
				else if (outcome.exitCode !== 0 && outcome.stderr.trim()) progress.error = outcome.stderr.trim();
			}
			progress.status = outcome.exitCode === 0 && !progress.error ? "completed" : "failed";
			progress.durationMs = Date.now() - startedAt;
			if (progress.error && !result.output) result.output = `Error: ${progress.error}`;

			const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_BYTES;
			result.originalOutputBytes = Buffer.byteLength(result.output, "utf-8");
			if (result.originalOutputBytes > maxBytes) {
				const truncation = truncateHead(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes });
				result.output = truncation.content;
				if (truncation.truncated) {
					result.output += "\n\n[Output truncated]";
					result.truncated = true;
				}
			}

			if (progress.status === "completed") {
				await options.onProgress?.({ type: "completed", agent: options.agentName, result }, progress);
			} else {
				await options.onProgress?.({
					type: "failed",
					agent: options.agentName,
					result,
					error: progress.error || result.output || `Subagent ${options.agentName} failed`,
				}, progress);
			}
			return result;
		},
	};
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" ? value : 0;
}
