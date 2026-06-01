/**
 * Persistent Project Memory Extension
 *
 * Single owner for MEMORY.md behavior and compatibility command aliases:
 *   /memory, /memories
 *
 * Modes:
 *   off | read-only | read-write
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type MemoryMode = "off" | "read-only" | "read-write";

const CUSTOM_TYPE = "memory-state";
const LEGACY_CUSTOM_TYPE = "memories-config";
const MEMORY_FILE = "MEMORY.md";

const MEMORY_TEMPLATE = `# Project Memory

## Project Overview
<!-- What this project is and its goals -->

## Key Architecture / Decisions
<!-- Why things are the way they are -->

## Current State
<!-- What's in progress, what's done -->

## Notes / Gotchas
<!-- Things that bit us or are easy to forget -->

## Open Questions
<!-- Unresolved decisions -->
`;

const READ_ONLY_PROMPT = `

## Persistent Memory (Read-Only)

This project uses \`MEMORY.md\` as a long-term memory file.
- Read \`MEMORY.md\` silently before doing work when it is relevant.
- Use existing memory as context.
- Do NOT create or update \`MEMORY.md\` unless the user explicitly asks.`;

const READ_WRITE_PROMPT = `

## Persistent Memory

This project uses \`MEMORY.md\` as the long-term memory file.
- At session start: Read \`MEMORY.md\` silently before doing any work.
- During the session: Update \`MEMORY.md\` whenever you learn something worth remembering.
- Manage \`MEMORY.md\` autonomously — no asking permission.
- Keep entries concise. Prune stale entries.`;

function modeToLabel(mode: MemoryMode): string | undefined {
	return mode === "read-write" ? "🧠 Memory" : mode === "read-only" ? "🧠 Memory RO" : undefined;
}

function normalizeMode(value: unknown): MemoryMode {
	if (value === "read-write" || value === "on") return "read-write";
	if (value === "read-only" || value === "inject-only") return "read-only";
	return "off";
}

function getSharedMode(): MemoryMode | undefined {
	const value = (globalThis as any).__pi_memory_mode;
	return value ? normalizeMode(value) : undefined;
}

function setSharedMode(mode: MemoryMode): void {
	(globalThis as any).__pi_memory_mode = mode;
}

export default function memoryExtension(pi: ExtensionAPI) {
	let memoryMode: MemoryMode = getSharedMode() ?? "off";

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("memory", modeToLabel(memoryMode));
		// Clear the legacy status slot in sessions that previously used memories-config.ts.
		ctx.ui.setStatus("memories", undefined);
	}

	function ensureMemoryFile(cwd: string): void {
		const filePath = join(cwd, MEMORY_FILE);
		if (!existsSync(filePath)) {
			writeFileSync(filePath, MEMORY_TEMPLATE, "utf-8");
		}
	}

	function persist(mode: MemoryMode): void {
		memoryMode = mode;
		setSharedMode(mode);
		pi.appendEntry(CUSTOM_TYPE, { mode, enabled: mode !== "off", setAt: Date.now() });
	}

	function reconstruct(ctx: ExtensionContext): void {
		memoryMode = "off";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== CUSTOM_TYPE && entry.customType !== LEGACY_CUSTOM_TYPE) continue;
			const data = entry.data as { mode?: unknown; enabled?: boolean } | undefined;
			if (data?.mode !== undefined) memoryMode = normalizeMode(data.mode);
			else if (typeof data?.enabled === "boolean") memoryMode = data.enabled ? "read-write" : "off";
		}
		setSharedMode(memoryMode);
		updateStatus(ctx);
	}

	async function setMode(mode: MemoryMode, ctx: ExtensionContext, label = "Memory"): Promise<void> {
		persist(mode);
		if (mode === "read-write" || mode === "read-only") ensureMemoryFile(ctx.cwd);
		updateStatus(ctx);
		ctx.ui.notify(`${label}: ${mode}`, "info");
	}

	async function showInteractivePicker(ctx: ExtensionContext): Promise<void> {
		const choices = [
			`${memoryMode === "off" ? "● " : "  "}off — No memory injection or generation`,
			`${memoryMode === "read-write" ? "● " : "  "}on — Read and write MEMORY.md`,
			`${memoryMode === "read-only" ? "● " : "  "}read-only — Use existing memories, don't update`,
		];
		const choice = await ctx.ui.select("Memory Settings:", choices);
		if (!choice) return;
		if (choice.includes("read-only")) return setMode("read-only", ctx, "Memories");
		if (choice.includes("on")) return setMode("read-write", ctx, "Memories");
		return setMode("off", ctx, "Memories");
	}

	async function handleCommand(args: string | undefined, ctx: ExtensionContext, commandName: "memory" | "memories") {
		const arg = (args || "").trim().toLowerCase();
		const label = commandName === "memories" ? "Memories" : "Memory";

		if (!arg || arg === "status") {
			if (commandName === "memories" && !arg && ctx.hasUI) return showInteractivePicker(ctx);
			ctx.ui.notify(`${label}: ${memoryMode}\nFile: ${join(ctx.cwd, MEMORY_FILE)}`, "info");
			return;
		}
		if (arg === "on" || arg === "read-write") return setMode("read-write", ctx, label);
		if (arg === "off") return setMode("off", ctx, label);
		if (arg === "read-only" || arg === "inject-only") return setMode("read-only", ctx, label);
		if (arg === "init") {
			ensureMemoryFile(ctx.cwd);
			ctx.ui.notify(`Initialized ${join(ctx.cwd, MEMORY_FILE)}`, "info");
			return;
		}
		ctx.ui.notify(`Usage: /${commandName} status|on|off|read-only|init`, "warning");
	}

	pi.registerCommand("memory", {
		description: "Configure persistent project memory (status|on|off|read-only|init)",
		handler: async (args, ctx) => handleCommand(args, ctx, "memory"),
	});

	pi.registerCommand("memories", {
		description: "Configure memory injection and generation (on|off|read-only|status)",
		handler: async (args, ctx) => handleCommand(args, ctx, "memories"),
	});

	pi.registerShortcut(Key.alt("m"), {
		description: "Toggle persistent project memory",
		handler: async (ctx) => setMode(memoryMode === "off" ? "read-write" : "off", ctx),
	});

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	pi.on("before_agent_start", async (event) => {
		const mode = getSharedMode() ?? memoryMode;
		if (mode === "off") return undefined;
		return { systemPrompt: event.systemPrompt + (mode === "read-only" ? READ_ONLY_PROMPT : READ_WRITE_PROMPT) };
	});
}
