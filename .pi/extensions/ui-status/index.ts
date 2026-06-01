/**
 * Status Extension - Recreates Codex's `/status` command
 *
 * Shows session configuration, token usage, model info, and workspace details.
 *
 * Commands:
 *   /status             - Show full session status
 *   /status brief       - Show brief status summary
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function latestCustom<T>(entries: any[], customType: string): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === customType) return entry.data as T;
	}
	return undefined;
}

function latestToolDetails<T>(entries: any[], toolName: string): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const msg = entry.type === "message" ? entry.message : undefined;
		if (msg?.role === "toolResult" && msg.toolName === toolName) return msg.details as T;
	}
	return undefined;
}

function latestAssistantModel(entries: any[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const msg = entry.type === "message" ? entry.message : undefined;
		if (msg?.role === "assistant" && msg.model) return msg.model as string;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show session configuration and status",
		handler: async (args, ctx) => {
			const brief = (args || "").trim() === "brief";

			// Gather status info
			const sessionFile = ctx.sessionManager.getSessionFile();
			const entryCount = ctx.sessionManager.getBranch().length;
			const leafEntry = ctx.sessionManager.getLeafEntry();

			// Count messages by type
			const entries = ctx.sessionManager.getBranch();
			const userMessages = entries.filter((e: any) => e.type === "message" && e.message?.role === "user").length;
			const assistantMessages = entries.filter((e: any) => e.type === "message" && e.message?.role === "assistant").length;
			const toolResults = entries.filter((e: any) => e.type === "message" && e.message?.role === "toolResult").length;

			const usage = ctx.getContextUsage();

			const cwd = ctx.cwd;
			const modeState = latestCustom<{ mode?: string }>(entries, "approval-mode-state");
			const sandboxState = latestCustom<{ mode?: string }>(entries, "sandbox-state");
			const goalState = latestCustom<{ state?: { objective?: string; status?: string } }>(entries, "goal-state")?.state;
			const todoDetails = latestToolDetails<{ todos?: Array<{ status?: string }> }>(entries, "todo");
			const subagentDetails = latestToolDetails<{ results?: Array<{ progress?: { status?: string } }> }>(entries, "subagent");
			const model = latestAssistantModel(entries);

			const permissionMode = modeState?.mode || "default";
			const sandboxMode = sandboxState?.mode || "workspace-write";
			const todos = todoDetails?.todos || [];
			const activeTodos = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
			const activeGoal = goalState && goalState.status !== "cleared" && goalState.status !== "completed"
				? `${goalState.status || "active"}: ${goalState.objective || "(no objective)"}`
				: "none";
			const subagents = subagentDetails?.results || [];
			const runningSubagents = subagents.filter((r) => r.progress?.status === "running").length;

			if (brief) {
				const lines = [
					`Session: ${sessionFile || "ephemeral"} | ${entryCount} entries | ${userMessages} prompts`,
					`Mode: ${permissionMode} | Sandbox: ${sandboxMode}`,
					usage ? `Context: ~${Math.round(usage.tokens / 1000)}k tokens` : "",
					`Cwd: ${cwd}`,
				].filter(Boolean);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const lines = [
				"Session Status",
				"==============",
				"",
				`Session:      ${sessionFile || "ephemeral (not saved)"}`,
				`Directory:    ${cwd}`,
				`Model:        ${model || "unknown"}`,
				`Permissions:  ${permissionMode}`,
				`Sandbox:      ${sandboxMode}`,
				`Todos:        ${activeTodos} active, ${todos.length} total`,
				`Goal:         ${activeGoal}`,
				`Subagents:    ${runningSubagents} running${subagents.length ? `, ${subagents.length} in last run` : ""}`,
				"",
				"Messages",
				"--------",
				`User msgs:      ${userMessages}`,
				`Assistant msgs: ${assistantMessages}`,
				`Tool results:   ${toolResults}`,
				`Total entries:  ${entryCount}`,
				"",
			];

			if (usage) {
				lines.push("Context");
				lines.push("-------");
				lines.push(`Tokens:    ${usage.tokens?.toLocaleString() || "unknown"}`);
				if (usage.maxTokens) {
					const pct = ((usage.tokens / usage.maxTokens) * 100).toFixed(1);
					lines.push(`Max:       ${usage.maxTokens?.toLocaleString()} (${pct}%)`);
				}
				lines.push("");
			}

			if (leafEntry) {
				lines.push("Position");
				lines.push("--------");
				lines.push(`Leaf: ${leafEntry.id}`);
				lines.push("");
			}

			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			} else {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});
}
