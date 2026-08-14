import { describe, expect, it } from "vitest";
import { buildActiveTodoPrompt } from "./todo-prompt.ts";

describe("todo system prompt", () => {
	it("includes only unfinished items without explanations or status prose", () => {
		const prompt = buildActiveTodoPrompt([
			{ id: "1", text: "Implement feature", status: "in_progress", explanation: "Started" },
			{ id: "2", text: "Verify feature", status: "pending" },
			{ id: "3", text: "Old work", status: "completed", explanation: "Done" },
			{ id: "4", text: "Dropped work", status: "cancelled" },
		]);

		expect(prompt).toContain("◐ #1 Implement feature");
		expect(prompt).toContain("○ #2 Verify feature");
		expect(prompt).not.toContain("Old work");
		expect(prompt).not.toContain("Dropped work");
		expect(prompt).not.toContain("Started");
		expect(prompt).toContain("complete it only after verification");
	});
});
