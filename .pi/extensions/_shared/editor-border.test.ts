import { describe, expect, it, vi } from "vitest";
import { reapplyThinkingBorder } from "./editor-border.ts";

describe("reapplyThinkingBorder", () => {
	it("restores the live thinking border after Pi mounts a custom editor", async () => {
		const borderColor = (text: string) => `max:${text}`;
		const getThinkingBorderColor = vi.fn(() => borderColor);
		const editor = { borderColor: (_text: string) => "stale" };
		const tui = { requestRender: vi.fn() };
		const ctx = {
			thinkingLevel: "max",
			ui: {
				theme: {
					getThinkingBorderColor,
				},
			},
		} as any;

		reapplyThinkingBorder(ctx, editor, tui);
		editor.borderColor = (_text: string) => "copied-from-default-editor";

		await Promise.resolve();

		expect(editor.borderColor("─")).toBe("max:─");
		expect(getThinkingBorderColor).toHaveBeenCalledWith("max");
		expect(tui.requestRender).toHaveBeenCalledOnce();
	});
});
