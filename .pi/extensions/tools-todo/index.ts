/**
 * Todo Extension - Structured task list with status and active reminders
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to view the list
 * - Shows a persistent todo summary widget above the input field
 * - Injects active todo summary into the system prompt (survives compaction)
 *
 * Single action model: `update` — always pass the full list.
 * - Create: pass a whole set of new todos
 * - Update: pass the full list with changed statuses (pending → in_progress → completed)
 * - Add: pass existing todos + new ones
 * - Delete: pass an empty array
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerToolErrorHandler, renderToolSummary } from "../_shared/tool-result-ui.ts";
import { UI_GLYPHS } from "../_shared/ui-style.ts";
import { buildActiveTodoPrompt } from "./todo-prompt.ts";
import {
	applyTodoUpdate,
	reconstructTodoState,
	type Todo,
	type TodoStatus,
} from "./todo-state.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TodoDetails {
	todos: Todo[];
	nextId: string;
	error?: string;
	/** Diff summary of what changed */
	summary?: string;
}

// ─── Status helpers ──────────────────────────────────────────────────────────

function statusIcon(status: TodoStatus): string {
	switch (status) {
		case "pending":
			return UI_GLYPHS.unchecked;
		case "in_progress":
			return UI_GLYPHS.running;
		case "completed":
			return UI_GLYPHS.confirm;
		case "cancelled":
			return UI_GLYPHS.cancel;
	}
}

interface TodoViewModel {
	all: Todo[];
	nonCancelled: Todo[];
	ordered: Todo[];
	counts: Record<TodoStatus, number>;
}

function buildTodoViewModel(todos: Todo[], includeCancelled = true): TodoViewModel {
	const all = [...todos];
	const nonCancelled = all.filter((t) => t.status !== "cancelled");
	const source = includeCancelled ? all : nonCancelled;
	return {
		all,
		nonCancelled,
		ordered: [...source],
		counts: {
			in_progress: source.filter((t) => t.status === "in_progress").length,
			pending: source.filter((t) => t.status === "pending").length,
			completed: source.filter((t) => t.status === "completed").length,
			cancelled: source.filter((t) => t.status === "cancelled").length,
		},
	};
}

function renderTodoLine(todo: Todo, theme: Theme, explanationLimit?: number): string {
	const icon = statusIcon(todo.status);
	const thKey =
		todo.status === "in_progress"
			? "accent"
			: todo.status === "completed"
				? "success"
				: todo.status === "cancelled"
					? "dim"
					: "dim";
	const check = theme.fg(thKey, icon);
	const id = theme.fg("accent", `#${todo.id}`);
	const itemText =
		todo.status === "completed"
			? theme.fg("dim", todo.text)
			: todo.status === "cancelled"
				? theme.fg("dim", todo.text)
				: todo.status === "in_progress"
					? theme.fg("text", theme.bold(todo.text))
					: theme.fg("muted", todo.text);

	let line = `${check} ${id} ${itemText}`;
	if (todo.explanation && todo.status !== "pending") {
		const suffix =
			explanationLimit && todo.explanation.length > explanationLimit
				? `${todo.explanation.slice(0, explanationLimit)}…`
				: todo.explanation;
		line += theme.fg("dim", ` — ${suffix}`);
	}
	return line;
}

function selectWidgetTodos(vm: TodoViewModel): Todo[] {
	const allNonCancelled = vm.nonCancelled;
	if (allNonCancelled.length <= 5) return allNonCancelled;

	const progressIndex = allNonCancelled.findIndex((t) => t.status !== "completed");
	if (progressIndex === -1) return allNonCancelled.slice(-5);

	let start = Math.max(0, progressIndex - 2);
	let end = Math.min(allNonCancelled.length, progressIndex + 3);

	while (end - start < 5) {
		if (start > 0) {
			start--;
		} else if (end < allNonCancelled.length) {
			end++;
		} else {
			break;
		}
	}

	return allNonCancelled.slice(start, end);
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const TodoItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable ID. Auto-generated if omitted." })),
	text: Type.String({ description: "Todo description" }),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "cancelled"] as const, {
		description: "Status (default: pending)",
	})),
	explanation: Type.Optional(Type.String({ description: "Reason for status change" })),
});

const TodoParams = Type.Object({
	todos: Type.Array(TodoItemSchema, {
		description: "The full todo list. Pass all items to replace the entire list. Pass an empty array to clear all todos.",
	}),
});

// ─── UI Component: /todos command ───────────────────────────────────────────

class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const vm = buildTodoViewModel(this.todos, true);
			const counts = vm.counts;
			const parts: string[] = [];
			if (counts.in_progress) parts.push(th.fg("accent", `${counts.in_progress} in progress`));
			if (counts.pending) parts.push(th.fg("muted", `${counts.pending} pending`));
			if (counts.completed) parts.push(th.fg("success", `${counts.completed} completed`));
			if (counts.cancelled) parts.push(th.fg("dim", `${counts.cancelled} cancelled`));
			lines.push(truncateToWidth(`  ${parts.join(th.fg("dim", " • "))}`, width));
			lines.push("");

			for (const todo of vm.ordered) {
				lines.push(truncateToWidth(`  ${renderTodoLine(todo, th)}`, width));
				if (todo.explanation && todo.status !== "pending") {
					lines.push(truncateToWidth(`    ${th.fg("dim", `↳ ${todo.explanation}`)}`, width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	registerToolErrorHandler(pi, ["todo"], (event) => {
		const details = event.details as { error?: string } | undefined;
		return Boolean(details?.error);
	});

	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = "1";

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 * Handles backward compatibility with legacy {done: boolean} entries
	 * and legacy multi-action format.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		let reconstructed = reconstructTodoState(undefined);

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | (TodoDetails & { action?: string }) | undefined;
			if (details?.todos) reconstructed = reconstructTodoState(details.todos);
		}
		todos = reconstructed.todos;
		nextId = reconstructed.nextId;
	};

	// ── Widget: persistent todo summary above the input field ──────────────

	function updateTodoWidget(ctx: ExtensionContext): void {
		// Show widget only when there are active (pending or in_progress) todos
		const active = todos.filter((t) => t.status === "pending" || t.status === "in_progress");
		if (active.length === 0) {
			ctx.ui.setWidget("todo-list", undefined);
			return;
		}

		const vm = buildTodoViewModel(todos, false);
		const counts = vm.counts;
		const display = selectWidgetTodos(vm);
		const countParts: string[] = [];
		if (counts.in_progress) countParts.push(`${counts.in_progress} active`);
		if (counts.pending) countParts.push(`${counts.pending} pending`);
		if (counts.completed) countParts.push(`${counts.completed} done`);
		if (vm.nonCancelled.length > display.length) countParts.push(`showing ${display.length}/${vm.nonCancelled.length}`);

		const lines = [`Todos ${countParts.join(" · ")}`];
		for (const t of display) {
			const explanation = t.explanation && t.status !== "pending" ? ` - ${t.explanation.slice(0, 40)}` : "";
			lines.push(`${statusIcon(t.status)} #${t.id} ${t.text}${explanation}`);
		}
		ctx.ui.setWidget("todo-list", lines);
	}

	// ── Lifecycle hooks to keep widget in sync ──────────────────────────────

	const onSessionEvent = async (_event: any, ctx: ExtensionContext) => {
		reconstructState(ctx);
		if (ctx.hasUI) updateTodoWidget(ctx);
	};

	pi.on("session_start", onSessionEvent);
	pi.on("session_tree", onSessionEvent);

	// Keep widget updated after each turn
	pi.on("turn_end", async (_event, ctx) => {
		if (ctx.hasUI) updateTodoWidget(ctx);
	});

	// ── Inject active todo reminder into system prompt ──────────────────────
	// This ensures the LLM always has access to its todo state,
	// even after context compaction removes earlier conversation.
	pi.on("before_agent_start", async (event, _ctx) => {
		const unfinished = todos.filter((todo) =>
			todo.status === "pending" || todo.status === "in_progress"
		);
		if (unfinished.length === 0) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildActiveTodoPrompt(unfinished)}`,
		};
	});

	// ── Register the todo tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Track multi-step work.",
		promptSnippet: "Track tasks",
		promptGuidelines: [
			"For non-trivial work with at least three distinct steps, create a todo list before implementation.",
			"On updates, send the full list and reuse item IDs. Keep exactly one item in_progress; complete items only after implementation and verification.",
			"Keep items specific, preserve user commands verbatim, and clear the list when work ends.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const incoming = params.todos;
			const previousTodos = todos;
			const result = applyTodoUpdate({ todos, nextId }, incoming ?? []);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: {
						todos: result.state.todos,
						nextId: result.state.nextId,
						error: result.error,
					} as TodoDetails,
					isError: true,
				};
			}
			const newTodos = result.state.todos;

			// ── Compute diff summary ────────────────────────────────────────
			const added = newTodos.filter((n) => !todos.find((o) => o.id === n.id)).length;
			const removed = previousTodos.filter((o) => !newTodos.find((n) => n.id === o.id)).length;
			const updated = newTodos.filter((n) => {
				const old = previousTodos.find((o) => o.id === n.id);
				return old && (old.status !== n.status || old.text !== n.text);
			}).length;
			const diffParts: string[] = [];
			if (added) diffParts.push(`+${added} added`);
			if (updated) diffParts.push(`~${updated} updated`);
			if (removed) diffParts.push(`-${removed} removed`);
			const diffSummary = diffParts.join(", ") || "no changes";

			todos = result.state.todos;
			nextId = result.state.nextId;

			return {
				content: [{ type: "text", text: `${diffSummary} (${todos.length} items)` }],
				details: { todos: [...todos], nextId, summary: diffSummary } as TodoDetails,
			};
		},

		renderCall(args, theme, _context) {
			const count = args.todos?.length ?? 0;
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `update`);
			text += ` ${theme.fg("dim", `(${count} items)`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return renderToolSummary(theme, "running", "Updating todos…");
			const details = result.details as TodoDetails | undefined;
			if (details?.error || context.isError) {
				const message = details?.error ?? result.content.find((content) => content.type === "text")?.text ?? "Todo update failed.";
				return renderToolSummary(theme, "error", message);
			}
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const todoList = details.todos;

			// Clear / empty result
			if (todoList.length === 0) {
				return renderToolSummary(theme, "success", "Cleared all todos");
			}

			// Normal update result — show a compact summary until expanded.
			const sorted = buildTodoViewModel(todoList, true).ordered;
			const summary = details.summary || `Updated (${todoList.length} items)`;
			if (!expanded) return renderToolSummary(theme, "success", summary, true);

			let text = theme.fg("success", `${UI_GLYPHS.confirm} `) + theme.fg("muted", summary);
			for (const todo of sorted) text += `\n${renderTodoLine(todo, theme)}`;
			return new Text(text, 0, 0);
		},
	});

	// ── Register /todos command ────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires TUI mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
