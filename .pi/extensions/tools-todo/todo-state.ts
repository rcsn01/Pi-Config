export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Todo {
	id: string;
	text: string;
	status: TodoStatus;
	explanation?: string;
}

export interface TodoInput {
	id?: string;
	text: string;
	status?: TodoStatus;
	explanation?: string;
}

export interface TodoState {
	todos: Todo[];
	nextId: string;
}

export type TodoUpdateResult =
	| { ok: true; state: TodoState }
	| { ok: false; state: TodoState; error: string };

const TODO_STATUSES = new Set<TodoStatus>([
	"pending",
	"in_progress",
	"completed",
	"cancelled",
]);

export function reconstructTodoState(rawTodos: readonly unknown[] | undefined): TodoState {
	if (!rawTodos?.length) return { todos: [], nextId: "1" };
	const migrated = rawTodos.map(migrateTodo);
	const usedIds = new Set<string>();
	let nextNumericId = deriveNextNumericId(migrated);
	let hasInProgress = false;
	const todos = migrated.map((todo) => {
		let id = todo.id;
		if (!id || usedIds.has(id)) {
			id = nextAvailableId(usedIds, nextNumericId);
			nextNumericId = Number(id) + 1;
		}
		usedIds.add(id);

		if (todo.status !== "in_progress") return { ...todo, id };
		if (!hasInProgress) {
			hasInProgress = true;
			return { ...todo, id };
		}
		return {
			...todo,
			id,
			status: "pending" as const,
			explanation: "Repaired during reconstruction: only one item can be in_progress",
		};
	});
	return { todos, nextId: String(deriveNextNumericId(todos)) };
}

export function applyTodoUpdate(
	current: TodoState,
	incoming: readonly TodoInput[],
): TodoUpdateResult {
	const prior = cloneState(current);
	if (incoming.length === 0) {
		return { ok: true, state: { todos: [], nextId: "1" } };
	}

	const explicitIds = new Set<string>();
	for (const item of incoming) {
		if (!item.id) continue;
		const id = String(item.id);
		if (explicitIds.has(id)) {
			return { ok: false, state: prior, error: `duplicate todo id: ${id}` };
		}
		explicitIds.add(id);
	}

	const normalized = incoming.map((item) => ({
		id: item.id ? String(item.id) : undefined,
		text: item.text,
		status: item.status ?? "pending",
		explanation: item.explanation,
	}));
	const activeIndexes = normalized
		.map((item, index) => item.status === "in_progress" ? index : -1)
		.filter((index) => index >= 0);
	if (activeIndexes.length > 1) {
		const currentActiveId = current.todos.find((todo) => todo.status === "in_progress")?.id;
		const currentIndex = currentActiveId
			? activeIndexes.find((index) => normalized[index].id === currentActiveId)
			: undefined;
		if (activeIndexes.length === 2 && currentIndex !== undefined) {
			normalized[currentIndex] = {
				...normalized[currentIndex],
				status: "pending",
				explanation: "Auto-demoted: another item set in_progress",
			};
		} else {
			return {
				ok: false,
				state: prior,
				error: `at most one item can be in_progress (found ${activeIndexes.length})`,
			};
		}
	}

	const usedIds = new Set(explicitIds);
	let nextNumericId = deriveNextNumericId(normalized.flatMap((item) => item.id
		? [{ id: item.id }]
		: []));
	const todos = normalized.map((item): Todo => {
		let id = item.id;
		if (!id) {
			id = nextAvailableId(usedIds, nextNumericId);
			nextNumericId = Number(id) + 1;
			usedIds.add(id);
		}
		return {
			id,
			text: item.text,
			status: item.status,
			explanation: item.explanation,
		};
	});

	return {
		ok: true,
		state: { todos, nextId: String(deriveNextNumericId(todos)) },
	};
}

export function deriveNextNumericId(items: readonly { id: string }[]): number {
	let maximum = 0;
	for (const item of items) {
		if (!/^[1-9]\d*$/.test(item.id)) continue;
		const value = Number(item.id);
		if (Number.isSafeInteger(value)) maximum = Math.max(maximum, value);
	}
	return maximum + 1;
}

function migrateTodo(raw: unknown): Todo {
	if (!isRecord(raw)) return { id: "", text: "Unknown", status: "pending" };
	const status = typeof raw.status === "string" && TODO_STATUSES.has(raw.status as TodoStatus)
		? raw.status as TodoStatus
		: typeof raw.done === "boolean" && raw.done
			? "completed"
			: "pending";
	return {
		id: raw.id === undefined || raw.id === null ? "" : String(raw.id),
		text: String(raw.text ?? "Unknown"),
		status,
		explanation: typeof raw.explanation === "string" ? raw.explanation : undefined,
	};
}

function nextAvailableId(usedIds: ReadonlySet<string>, start: number): string {
	let candidate = Math.max(1, start);
	while (usedIds.has(String(candidate))) candidate++;
	return String(candidate);
}

function cloneState(state: TodoState): TodoState {
	return { todos: state.todos.map((todo) => ({ ...todo })), nextId: state.nextId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}