import { describe, expect, it } from "vitest";
import { applyTodoUpdate, reconstructTodoState, type TodoState } from "./todo-state.ts";

const current: TodoState = {
	todos: [
		{ id: "1", text: "First", status: "in_progress" },
		{ id: "4", text: "Second", status: "pending" },
	],
	nextId: "5",
};

describe("todo state", () => {
	it("repairs legacy reconstruction and derives nextId instead of trusting persisted state", () => {
		expect(reconstructTodoState([
			{ id: 2, text: "Legacy complete", done: true },
			{ id: "2", text: "Duplicate", status: "in_progress" },
			{ id: "9", text: "Second active", status: "in_progress" },
		])).toEqual({
			todos: [
				{ id: "2", text: "Legacy complete", status: "completed", explanation: undefined },
				{ id: "10", text: "Duplicate", status: "in_progress", explanation: undefined },
				{
					id: "9",
					text: "Second active",
					status: "pending",
					explanation: "Repaired during reconstruction: only one item can be in_progress",
				},
			],
			nextId: "11",
		});
	});

	it("rejects duplicate explicit IDs without mutating state or input", () => {
		const incoming = [
			{ id: "4", text: "One", status: "pending" as const },
			{ id: "4", text: "Two", status: "completed" as const },
		];
		const before = structuredClone(incoming);
		const result = applyTodoUpdate(current, incoming);
		expect(result).toMatchObject({ ok: false, error: "duplicate todo id: 4", state: current });
		expect(incoming).toEqual(before);
	});

	it("generates collision-free IDs and derives nextId from the final list", () => {
		const result = applyTodoUpdate(current, [
			{ id: "7", text: "Existing", status: "completed" },
			{ text: "Generated one" },
			{ text: "Generated two" },
		]);
		expect(result).toEqual({
			ok: true,
			state: {
				todos: [
					{ id: "7", text: "Existing", status: "completed", explanation: undefined },
					{ id: "8", text: "Generated one", status: "pending", explanation: undefined },
					{ id: "9", text: "Generated two", status: "pending", explanation: undefined },
				],
				nextId: "10",
			},
		});
	});

	it("auto-demotes the prior active item only for an unambiguous replacement", () => {
		const result = applyTodoUpdate(current, [
			{ id: "1", text: "First", status: "in_progress" },
			{ id: "4", text: "Second", status: "in_progress" },
		]);
		expect(result).toMatchObject({
			ok: true,
			state: {
				todos: [
					{ id: "1", status: "pending", explanation: "Auto-demoted: another item set in_progress" },
					{ id: "4", status: "in_progress" },
				],
			},
		});
		expect(applyTodoUpdate(current, [
			{ id: "2", text: "Two", status: "in_progress" },
			{ id: "3", text: "Three", status: "in_progress" },
		])).toMatchObject({ ok: false, error: "at most one item can be in_progress (found 2)" });
	});

	it("clears state and resets the counter", () => {
		expect(applyTodoUpdate(current, [])).toEqual({
			ok: true,
			state: { todos: [], nextId: "1" },
		});
	});
});