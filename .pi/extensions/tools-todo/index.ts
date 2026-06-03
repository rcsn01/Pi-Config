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

// ─── Types ───────────────────────────────────────────────────────────────────

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface Todo {
	id: string;
	text: string;
	status: TodoStatus;
	/** Most recent explanation for a status change */
	explanation?: string;
}

interface TodoDetails {
	todos: Todo[];
	nextId: string;
	error?: string;
	/** Diff summary of what changed */
	summary?: string;
}

/** Legacy shape for backward-compatible reconstruction */
interface LegacyTodo {
	id: number;
	text: string;
	done: boolean;
}

// ─── Status helpers ──────────────────────────────────────────────────────────

const STATUS_ORDER: Record<TodoStatus, number> = {
	in_progress: 0,
	pending: 1,
	completed: 2,
	cancelled: 3,
};

function sortTodos(todos: Todo[]): Todo[] {
	return [...todos].sort((a, b) => {
		return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
	});
}

function statusIcon(status: TodoStatus): string {
	switch (status) {
		case "pending":
			return "○";
		case "in_progress":
			return "◐";
		case "completed":
			return "✓";
		case "cancelled":
			return "✗";
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
		ordered: sortTodos(source),
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
				? theme.fg("dim", `✗ ${todo.text}`)
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
	const uncompleted = sortTodos(allNonCancelled.filter((t) => t.status !== "completed"));
	const completed = allNonCancelled
		.filter((t) => t.status === "completed")
		.sort((a, b) => Number(b.id) - Number(a.id));

	if (allNonCancelled.length <= 8) return sortTodos(allNonCancelled);
	if (uncompleted.length <= 4) return sortTodos(allNonCancelled).slice(-8);

	const display = [
		...completed.slice(0, 3),
		...uncompleted.filter((t) => t.status === "in_progress").slice(0, 1),
		...uncompleted.filter((t) => t.status === "pending").slice(0, 4),
	];

	if (display.length >= 8) return display;
	const shownIds = new Set(display.map((t) => t.id));
	return [...display, ...sortTodos(allNonCancelled.filter((t) => !shownIds.has(t.id))).slice(0, 8 - display.length)];
}

/** Migrate a legacy {done: boolean} entry to the new {status} shape */
function migrateLegacy(raw: any): Todo {
	// If it already has a status field, use it
	if (raw && typeof raw.status === "string") {
		return {
			id: String(raw.id),
			text: String(raw.text),
			status: raw.status as TodoStatus,
			explanation: raw.explanation,
		};
	}
	// Legacy: done: boolean → status
	if (raw && typeof raw.done === "boolean") {
		return {
			id: String(raw.id),
			text: String(raw.text),
			status: raw.done ? "completed" : "pending",
		};
	}
	// Fallback
	return {
		id: String(raw.id),
		text: String(raw.text ?? "Unknown"),
		status: "pending",
	};
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
		todos = [];
		nextId = "1";

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | (TodoDetails & { action?: string }) | undefined;
			if (details) {
				// Migrate any legacy entries in the stored todos
				if (details.todos) {
					todos = details.todos.map(migrateLegacy);
				}
				// Ensure nextId is a string
				nextId = String(details.nextId);
			}
		}
	};

	// ── Widget: persistent todo summary above the input field ──────────────

	function updateTodoWidget(ctx: ExtensionContext): void {
		// Show widget when there are any non-cancelled todos
		const nonCancelled = todos.filter((t) => t.status !== "cancelled");
		if (nonCancelled.length === 0) {
			ctx.ui.setWidget("todo-list", undefined);
			return;
		}

		ctx.ui.setWidget("todo-list", (_tui: any, theme: Theme) => {
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			return {
				render(width: number): string[] {
					if (cachedLines && cachedWidth === width) {
						return cachedLines;
					}

					const lines: string[] = [];
					const vm = buildTodoViewModel(todos, false);
					const completed = vm.nonCancelled.filter((t) => t.status === "completed");
					const counts = vm.counts;
					const countParts: string[] = [];
					if (counts.in_progress) countParts.push(theme.fg("accent", `${counts.in_progress} active`));
					if (counts.pending) countParts.push(theme.fg("muted", `${counts.pending} pending`));
					if (counts.completed) countParts.push(theme.fg("success", `${counts.completed} done`));

					const header = theme.fg("accent", "Todos") + " " + theme.fg("dim", countParts.join(theme.fg("dim", " · ")));
					lines.push(truncateToWidth(`  ${header}`, width));

					const display = selectWidgetTodos(vm);

					for (const t of display) {
						lines.push(truncateToWidth(`  ${renderTodoLine(t, theme, 40)}`, width));
					}

					// Show overflow count
					const shownIds = new Set(display.map((t) => t.id));
					const overflowDone = completed.filter((t) => !shownIds.has(t.id)).length;
					const overflowPending = vm.nonCancelled.filter((t) => t.status === "pending" && !shownIds.has(t.id)).length;
					const overflowInProgress = vm.nonCancelled.filter((t) => t.status === "in_progress" && !shownIds.has(t.id)).length;
					if (overflowDone || overflowPending || overflowInProgress) {
						const overflowParts: string[] = [];
						if (overflowDone) overflowParts.push(`${overflowDone} more done`);
						if (overflowInProgress) overflowParts.push(`${overflowInProgress} more active`);
						if (overflowPending) overflowParts.push(`${overflowPending} more pending`);
						lines.push(truncateToWidth(`  ${theme.fg("dim", `… ${overflowParts.join(", ")}`)}`, width));
					}

					cachedWidth = width;
					cachedLines = lines;
					return lines;
				},

				invalidate(): void {
					cachedWidth = undefined;
					cachedLines = undefined;
				},
			};
		});
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
		const active = todos.filter((t) => t.status !== "cancelled");
		const uncompleted = active.filter((t) => t.status !== "completed");

		let todoReminder: string;

		if (uncompleted.length > 0) {
			// Active todos exist — inject full state so the agent stays on track
			todoReminder = buildActiveTodoPrompt(todos);
		} else {
			// No active todos — nudge the agent to create one if the task is multi-step
			todoReminder = "If the current task involves multiple steps, create a todo list before starting work. Use the todo tool to track progress.";
		}

		return {
			systemPrompt: event.systemPrompt + "\n\n" + todoReminder,
		};
	});

	// ── Register the todo tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a structured todo list. Always pass the full list of todos. " +
			"Use to: create a new list, update statuses (pending → in_progress → completed), " +
			"add items (include existing + new), or delete all (pass empty array).",
		promptSnippet: "Update todo list",
		promptGuidelines: [
			"Create a todo list for any multi-step task. Do not begin work without one when the task involves 3+ distinct steps, is non-trivial, or the user provides multiple tasks.",
			"Always pass the FULL list of todos every time you call this tool — including unchanged items.",
			"To create a new list: pass all items as pending. To add items: include existing items + new ones.",
			"To update status: pass the full list with the changed statuses. Mark exactly one item as in_progress while work remains.",
			"Status flow: pending → in_progress → completed. Use cancelled for items no longer needed.",
			"Only one item can be in_progress at a time. Setting an item in_progress auto-demotes the previous one to pending.",
			"Mark completed only after the work is actually done, including verification. Never based on intent.",
			"Update status in real time; do not batch completions. Each completed step should be marked immediately.",
			"Preserve user-provided commands verbatim in todo text (flags, args, order).",
			"Break large work into smaller, specific, actionable steps. Avoid vague items like 'make it work'.",
			"Pass an empty todos array to clear all items.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const incoming = params.todos;

			// ── Clear (empty array) ─────────────────────────────────────────
			if (!incoming || incoming.length === 0) {
				const count = todos.length;
				todos = [];
				nextId = "1";
				return {
					content: [{ type: "text", text: count > 0 ? `Cleared ${count} todos` : "No todos to clear" }],
					details: { todos: [], nextId: "1", summary: count > 0 ? `-${count} removed` : "no changes" } as TodoDetails,
				};
			}

			// ── Validate: at most one in_progress ────────────────────────────
			const inProgressCount = incoming.filter((t) => t.status === "in_progress").length;
			if (inProgressCount > 1) {
				return {
					content: [
						{
							type: "text",
							text: `Error: at most one item can be in_progress (found ${inProgressCount})`,
						},
					],
					details: {
						todos: [...todos],
						nextId,
						error: `multiple in_progress (${inProgressCount})`,
					} as TodoDetails,
				};
			}

			// ── Auto-demote: if setting an item in_progress and current in_progress item exists ──
			if (inProgressCount === 1) {
				const newInProgress = incoming.find((t) => t.status === "in_progress");
				const currentInProgress = todos.find((t) => t.status === "in_progress");
				if (newInProgress && currentInProgress && String(newInProgress.id) !== String(currentInProgress.id)) {
					// Auto-demote the old in_progress item in the incoming list
					for (const t of incoming) {
						if (String(t.id) === String(currentInProgress.id) && t.status === "in_progress") {
							t.status = "pending";
							t.explanation = "Auto-demoted: another item set in_progress";
						}
					}
				}
			}

			// ── Build the new list, assigning IDs where missing ──────────────
			const newTodos: Todo[] = [];
			let maxId = 0;
			const usedIds = new Set<string>();

			// First pass: collect explicitly-provided IDs and find max
			for (const raw of incoming) {
				if (raw.id) {
					usedIds.add(String(raw.id));
					const num = Number(raw.id);
					if (!isNaN(num) && num > maxId) maxId = num;
				}
			}

			// Second pass: build the list, auto-assigning IDs for items without one
			let nextAutoId = maxId + 1;
			for (const raw of incoming) {
				const id = raw.id || String(nextAutoId++);
				newTodos.push({
					id,
					text: raw.text,
					status: raw.status || "pending",
					explanation: raw.explanation,
				});
			}

			// ── Compute diff summary ────────────────────────────────────────
			const added = newTodos.filter((n) => !todos.find((o) => o.id === n.id)).length;
			const removed = todos.filter((o) => !newTodos.find((n) => n.id === o.id)).length;
			const updated = newTodos.filter((n) => {
				const old = todos.find((o) => o.id === n.id);
				return old && (old.status !== n.status || old.text !== n.text);
			}).length;
			const diffParts: string[] = [];
			if (added) diffParts.push(`+${added} added`);
			if (updated) diffParts.push(`~${updated} updated`);
			if (removed) diffParts.push(`-${removed} removed`);
			const diffSummary = diffParts.join(", ") || "no changes";

			todos = newTodos;
			nextId = String(maxId + 1);

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

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			// Clear / empty result
			if (todoList.length === 0) {
				return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}

			// Normal update result — show summary + items
			const sorted = buildTodoViewModel(todoList, true).ordered;
			let text = theme.fg("success", "✓ ") + theme.fg("muted", details.summary || `Updated (${todoList.length} items)`);

			const display = expanded ? sorted : sorted.slice(0, 5);
			for (const t of display) {
				text += `\n${renderTodoLine(t, theme, 50)}`;
			}
			if (!expanded && sorted.length > 5) {
				text += `\n${theme.fg("dim", `... ${sorted.length - 5} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// ── Register /todos command ────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}

// ─── System Prompt Builder ───────────────────────────────────────────────────

function buildActiveTodoPrompt(todos: Todo[]): string {
	const sorted = sortTodos(todos);
	const counts = {
		in_progress: todos.filter((t) => t.status === "in_progress").length,
		pending: todos.filter((t) => t.status === "pending").length,
		completed: todos.filter((t) => t.status === "completed").length,
		cancelled: todos.filter((t) => t.status === "cancelled").length,
	};

	const parts: string[] = [];
	if (counts.in_progress) parts.push(`${counts.in_progress} in_progress`);
	if (counts.pending) parts.push(`${counts.pending} pending`);
	if (counts.completed) parts.push(`${counts.completed} completed`);
	if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);

	let prompt = `## Active Todo List\n${parts.join(", ")}\n\n`;

	for (const t of sorted) {
		if (t.status === "cancelled") continue; // skip cancelled in system prompt
		const icon = statusIcon(t.status);
		let line = `${icon} #${t.id} ${t.text} (${t.status})`;
		if (t.explanation) line += ` — ${t.explanation}`;
		prompt += line + "\n";
	}

	prompt += `\nContinue working on the in_progress item. Mark items completed as you finish them. Use the todo tool to update the full list.`;

	return prompt;
}
