/**
 * Codex Integration Extension
 *
 * Exposes Codex CLI delegation tools to Pi:
 *   - codex_ask: read-only Codex analysis/planning
 *   - codex_review: Codex code review
 *   - codex_exec: write-capable Codex execution with user confirmation
 *
 * Requires the `codex` CLI to be installed and authenticated separately.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const CODEX_BIN = process.env.PI_CODEX_BIN || "codex";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_CAP_BYTES = 20 * 1024;

type CodexSandbox = "read-only" | "workspace-write";
type ReviewAction = "base" | "uncommitted" | "commit";

interface CodexRunResult {
	stdout: string;
	stderr: string;
	rawJsonEvents: unknown[];
	plainStdout: string[];
	exitCode: number;
	finalMessage: string;
	summary: string;
	toolCount: number;
	error?: string;
	outputFile: string;
	durationMs: number;
}

const AskParams = Type.Object({
	task: Type.String({ description: "Task, question, or analysis request to delegate to Codex" }),
	cwd: Type.Optional(Type.String({ description: "Optional working directory inside the current git repository, e.g. .pi/worktrees/item-123" })),
	model: Type.Optional(Type.String({ description: "Optional Codex model override, e.g. gpt-5-codex" })),
	profile: Type.Optional(Type.String({ description: "Optional Codex config profile" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds; default 30 minutes" })),
});

const ExecParams = Type.Object({
	task: Type.String({ description: "Implementation task to delegate to Codex" }),
	cwd: Type.Optional(Type.String({ description: "Optional working directory inside the current git repository, e.g. .pi/worktrees/item-123" })),
	sandbox: Type.Optional(StringEnum(["workspace-write", "read-only"] as const)),
	model: Type.Optional(Type.String({ description: "Optional Codex model override" })),
	profile: Type.Optional(Type.String({ description: "Optional Codex config profile" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds; default 30 minutes" })),
});

const ReviewParams = Type.Object({
	action: StringEnum(["base", "uncommitted", "commit"] as const),
	branch: Type.Optional(Type.String({ description: "Base branch name when action=base" })),
	commit: Type.Optional(Type.String({ description: "Commit SHA when action=commit" })),
	instructions: Type.Optional(Type.String({ description: "Additional review focus instructions" })),
	cwd: Type.Optional(Type.String({ description: "Optional working directory inside the current git repository, e.g. .pi/worktrees/item-123" })),
	model: Type.Optional(Type.String({ description: "Optional Codex model override" })),
	profile: Type.Optional(Type.String({ description: "Optional Codex config profile" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds; default 30 minutes" })),
});

function truncateForContext(text: string): { text: string; truncated: boolean; note?: string } {
	const trunc = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!trunc.truncated) return { text: trunc.content, truncated: false };
	return {
		text: trunc.content,
		truncated: true,
		note:
			`[Output truncated: showing ${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}` +
			` across ${trunc.outputLines} of ${trunc.totalLines} lines.]`,
	};
}

function capTail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let capped = text.slice(-maxBytes);
	while (Buffer.byteLength(capped, "utf8") > maxBytes) capped = capped.slice(1);
	return `[truncated to last ${formatSize(maxBytes)}]\n${capped}`;
}

function capHead(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let capped = text.slice(0, maxBytes);
	while (Buffer.byteLength(capped, "utf8") > maxBytes) capped = capped.slice(0, -1);
	return `${capped}\n[truncated to first ${formatSize(maxBytes)}]`;
}

function compactEventForDetails(event: unknown): unknown {
	const json = JSON.stringify(event);
	if (Buffer.byteLength(json, "utf8") <= 2 * 1024) return event;
	return { truncated: true, preview: capHead(json, 2 * 1024) };
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") parts.push(part);
		else if (part && typeof part === "object") {
			const p = part as Record<string, unknown>;
			if (typeof p.text === "string") parts.push(p.text);
			else if (typeof p.content === "string") parts.push(p.content);
		}
	}
	return parts.join("\n").trim();
}

function extractEventText(event: unknown): string {
	if (!event || typeof event !== "object") return "";
	const evt = event as Record<string, unknown>;

	if (typeof evt.text === "string") return evt.text;
	if (typeof evt.message === "string") return evt.message;
	if (evt.content !== undefined) return extractContentText(evt.content);

	const message = evt.message;
	if (message && typeof message === "object") {
		const m = message as Record<string, unknown>;
		if (typeof m.text === "string") return m.text;
		if (m.content !== undefined) return extractContentText(m.content);
	}

	const item = evt.item;
	if (item && typeof item === "object") {
		const i = item as Record<string, unknown>;
		if (typeof i.text === "string") return i.text;
		if (i.content !== undefined) return extractContentText(i.content);
	}

	return "";
}

function eventLooksLikeAssistantFinal(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const evt = event as Record<string, unknown>;
	const type = String(evt.type || "");
	const message = evt.message && typeof evt.message === "object" ? evt.message as Record<string, unknown> : undefined;
	const item = evt.item && typeof evt.item === "object" ? evt.item as Record<string, unknown> : undefined;

	return (
		type.includes("message") ||
		type.includes("completed") ||
		message?.role === "assistant" ||
		item?.role === "assistant" ||
		item?.type === "agent_message" ||
		item?.type === "assistant_message"
	);
}

function eventLooksLikeTool(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const evt = event as Record<string, unknown>;
	const type = String(evt.type || "").toLowerCase();
	const item = evt.item && typeof evt.item === "object" ? evt.item as Record<string, unknown> : undefined;
	return type.includes("tool") || type.includes("command") || String(item?.type || "").includes("command");
}

function eventError(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const evt = event as Record<string, unknown>;
	const type = String(evt.type || "").toLowerCase();
	if (!type.includes("error")) return undefined;
	return String(evt.error || evt.message || evt.reason || JSON.stringify(evt));
}

async function runCodex(
	args: string[],
	input: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void) | undefined,
	timeoutMs: number,
): Promise<CodexRunResult> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-codex-"));
	const outputFile = path.join(tempDir, "last-message.md");
	// Codex treats the final "-" as the stdin prompt marker, so output options must
	// be inserted before it rather than appended after it.
	const fullArgs = args[args.length - 1] === "-"
		? [...args.slice(0, -1), "-o", outputFile, "-"]
		: [...args, "-o", outputFile];
	const started = Date.now();

	let stdout = "";
	let stderr = "";
	let lineBuffer = "";
	let toolCount = 0;
	let lastEventText = "";
	let error: string | undefined;
	const rawJsonEvents: unknown[] = [];
	const plainStdout: string[] = [];

	const processLine = (line: string) => {
		if (!line.trim()) return;
		try {
			const event = JSON.parse(line) as unknown;
			rawJsonEvents.push(event);
			if (eventLooksLikeTool(event)) toolCount++;
			const maybeError = eventError(event);
			if (maybeError) error = maybeError;
			const text = extractEventText(event);
			if (text && eventLooksLikeAssistantFinal(event)) lastEventText = text;

			onUpdate?.({
				content: [{ type: "text", text: `Codex running… ${toolCount} tool/command event(s)` }],
				details: { toolCount, lastEventText: lastEventText.slice(-500) },
			});
		} catch {
			plainStdout.push(line);
		}
	};

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(CODEX_BIN, fullArgs, {
			cwd,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});

		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(code);
		};

		const timer = setTimeout(() => {
			stderr += `\n[timeout after ${timeoutMs}ms]`;
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			finish(-1);
		}, timeoutMs);

		proc.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdout += text;
			lineBuffer += text;
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			if (lineBuffer.trim()) processLine(lineBuffer);
			finish(code ?? 1);
		});

		proc.on("error", (err) => {
			stderr += err.message;
			finish(1);
		});

		if (input !== undefined) proc.stdin?.end(input);

		const kill = () => {
			stderr += "\n[aborted]";
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
		};
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });
	});

	let finalMessage = lastEventText || plainStdout.join("\n").trim();
	try {
		if (existsSync(outputFile)) {
			const fromFile = (await fs.readFile(outputFile, "utf8")).trim();
			if (fromFile) finalMessage = fromFile;
		}
	} catch {
		// Keep best-effort event/stdout output.
	}

	try {
		await fs.rm(tempDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup.
	}

	if (!finalMessage && stderr.trim()) finalMessage = capTail(stderr.trim(), STDERR_CAP_BYTES);
	const truncated = truncateForContext(finalMessage || "(Codex produced no final message.)");
	const summary = truncated.note ? `${truncated.text}\n\n${truncated.note}` : truncated.text;

	return {
		stdout: capTail(stdout, 100 * 1024),
		stderr: capTail(stderr, STDERR_CAP_BYTES),
		rawJsonEvents: rawJsonEvents.slice(-50).map(compactEventForDetails),
		plainStdout: plainStdout.slice(-50).map((line) => capHead(line, 2 * 1024)),
		exitCode,
		finalMessage: summary,
		summary,
		toolCount,
		error,
		outputFile: "temporary output file cleaned up after execution",
		durationMs: Date.now() - started,
	};
}

function commonCodexArgs(params: { model?: string; profile?: string }): string[] {
	const args: string[] = [];
	if (params.model) args.push("--model", params.model);
	if (params.profile) args.push("--profile", params.profile);
	return args;
}

function buildExecArgs(params: { model?: string; profile?: string }, cwd: string, sandbox: CodexSandbox): string[] {
	return [
		"exec",
		"--json",
		"--cd", cwd,
		"--sandbox", sandbox,
		"--skip-git-repo-check",
		"--ephemeral",
		...commonCodexArgs(params),
		"-",
	];
}

function buildReviewArgs(params: {
	action: ReviewAction;
	branch?: string;
	commit?: string;
	model?: string;
	profile?: string;
}): string[] {
	const args = ["exec", "review", "--json", "--ephemeral", ...commonCodexArgs(params)];
	if (params.action === "base") args.push("--base", params.branch || "main");
	else if (params.action === "uncommitted") args.push("--uncommitted");
	else if (params.action === "commit") args.push("--commit", params.commit || "HEAD");
	args.push("-");
	return args;
}

function formatFailure(prefix: string, result: CodexRunResult): string {
	const parts = [
		`${prefix} failed with exit code ${result.exitCode}.`,
		result.error ? `Codex error: ${result.error}` : undefined,
		result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
		result.summary.trim() ? `Output:\n${result.summary.trim()}` : undefined,
	].filter(Boolean);
	return parts.join("\n\n");
}

async function resolveRunCwd(pi: ExtensionAPI, ctx: ExtensionContext, requested?: string): Promise<string> {
	if (!requested?.trim()) return ctx.cwd;
	const cleaned = requested.trim().replace(/^@/, "");
	const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
	if (rootResult.code !== 0) {
		throw new Error(rootResult.stderr?.trim() || "codex cwd override requires a git repository");
	}
	const root = rootResult.stdout.trim();
	const resolved = path.resolve(ctx.cwd, cleaned);
	const rel = path.relative(root, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Codex cwd must be inside current repository: ${requested}`);
	}
	const stat = await fs.stat(resolved).catch(() => undefined);
	if (!stat?.isDirectory()) throw new Error(`Codex cwd does not exist or is not a directory: ${requested}`);
	return resolved;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "codex_ask",
		label: "Codex Ask",
		description: "Delegate a read-only analysis, planning, or second-opinion task to the local Codex CLI.",
		promptSnippet: "Ask local Codex CLI to analyze or plan in read-only mode",
		promptGuidelines: [
			"Use codex_ask when the user asks for a second opinion, cross-check, or read-only delegation to Codex.",
			"codex_ask runs Codex in read-only sandbox mode and returns Codex's final answer.",
		],
		parameters: AskParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runCwd = await resolveRunCwd(pi, ctx, params.cwd);
			const timeoutMs = params.timeoutMs || DEFAULT_TIMEOUT_MS;
			const result = await runCodex(
				buildExecArgs(params, runCwd, "read-only"),
				params.task,
				runCwd,
				signal,
				onUpdate,
				timeoutMs,
			);

			if (result.exitCode !== 0) {
				return {
					content: [{ type: "text", text: formatFailure("codex_ask", result) }],
					details: { ...result, cwd: runCwd },
				};
			}

			return {
				content: [{ type: "text", text: result.summary }],
				details: { ...result, cwd: runCwd },
			};
		},
	});

	pi.registerTool({
		name: "codex_review",
		label: "Codex Review",
		description: "Ask Codex CLI to review uncommitted changes, changes against a base branch, or a commit.",
		promptSnippet: "Run Codex code review (base|uncommitted|commit)",
		promptGuidelines: [
			"Use codex_review when the user explicitly asks Codex to review code or wants a second review opinion.",
			"After codex_review returns, summarize Codex's findings and call out any concrete issues it found.",
		],
		parameters: ReviewParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.action === "base" && !params.branch) {
				throw new Error("codex_review action=base requires branch");
			}
			if (params.action === "commit" && !params.commit) {
				throw new Error("codex_review action=commit requires commit");
			}

			const runCwd = await resolveRunCwd(pi, ctx, params.cwd);
			const timeoutMs = params.timeoutMs || DEFAULT_TIMEOUT_MS;
			const result = await runCodex(
				buildReviewArgs(params),
				params.instructions || "Review the selected changes thoroughly. Be specific and concise.",
				runCwd,
				signal,
				onUpdate,
				timeoutMs,
			);

			if (result.exitCode !== 0) {
				return {
					content: [{ type: "text", text: formatFailure("codex_review", result) }],
					details: { ...result, action: params.action, branch: params.branch, commit: params.commit, cwd: runCwd },
				};
			}

			return {
				content: [{ type: "text", text: result.summary }],
				details: { ...result, action: params.action, branch: params.branch, commit: params.commit, cwd: runCwd },
			};
		},
	});

	pi.registerTool({
		name: "codex_exec",
		label: "Codex Exec",
		description:
			"Delegate an implementation task to Codex CLI. Defaults to workspace-write and asks the user for confirmation before launching.",
		promptSnippet: "Delegate an implementation task to Codex CLI with confirmation",
		promptGuidelines: [
			"Use codex_exec only when the user explicitly wants Codex to perform or attempt implementation work.",
			"codex_exec can modify workspace files when sandbox=workspace-write; do not use it for routine questions or reviews.",
			"After codex_exec returns, inspect or summarize the resulting changes before claiming the task is complete.",
		],
		parameters: ExecParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const sandbox = (params.sandbox || "workspace-write") as CodexSandbox;
			const runCwd = await resolveRunCwd(pi, ctx, params.cwd);

			if (sandbox === "workspace-write") {
				if (!ctx.hasUI) {
					throw new Error("codex_exec workspace-write requires interactive confirmation");
				}
				const ok = await ctx.ui.confirm(
					"Allow Codex workspace-write?",
					`Codex will run in workspace-write mode in ${runCwd}. Continue?`,
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "codex_exec cancelled by user before launching Codex." }],
						details: { cancelled: true, sandbox, cwd: runCwd },
					};
				}
			}

			const timeoutMs = params.timeoutMs || DEFAULT_TIMEOUT_MS;
			const result = await runCodex(
				buildExecArgs(params, runCwd, sandbox),
				params.task,
				runCwd,
				signal,
				onUpdate,
				timeoutMs,
			);

			if (result.exitCode !== 0) {
				return {
					content: [{ type: "text", text: formatFailure("codex_exec", result) }],
					details: { ...result, sandbox, cwd: runCwd },
				};
			}

			return {
				content: [{ type: "text", text: result.summary }],
				details: { ...result, sandbox, cwd: runCwd },
			};
		},
	});

	pi.registerCommand("codex", {
		description: "Ask Pi to delegate to Codex: /codex ask|review|exec ...",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /codex ask <task> | /codex review <instructions> | /codex exec <task>", "info");
				return;
			}

			const [mode, ...restParts] = trimmed.split(/\s+/);
			const rest = restParts.join(" ").trim();
			if (!rest) {
				ctx.ui.notify(`Usage: /codex ${mode} <task or instructions>`, "warning");
				return;
			}

			if (mode === "ask") {
				pi.sendUserMessage(`Delegate this to Codex using codex_ask: ${rest}`);
			} else if (mode === "review") {
				pi.sendUserMessage(`Ask Codex to review the current uncommitted changes using codex_review with action=uncommitted. Focus: ${rest}`);
			} else if (mode === "exec") {
				pi.sendUserMessage(`Delegate this implementation task to Codex using codex_exec: ${rest}`);
			} else {
				ctx.ui.notify("Unknown /codex mode. Use ask, review, or exec.", "warning");
			}
		},
	});
}
