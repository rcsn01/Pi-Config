import type { Todo } from "./todo-state.ts";

export function buildActiveTodoPrompt(todos: readonly Todo[]): string {
	const lines = todos
		.filter((todo) => todo.status === "pending" || todo.status === "in_progress")
		.map((todo) => `${todo.status === "in_progress" ? "◐" : "○"} #${todo.id} ${todo.text}`);
	return `## Todos\n${lines.join("\n")}\n\nUpdate the full list; keep one item in_progress and complete it only after verification.`;
}
