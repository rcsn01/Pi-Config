import { describe, expect, it, vi } from "vitest";
import contextDiagnosticsExtension from "./index.ts";

function harness() {
	let command: any;
	const pi: any = {
		registerCommand: vi.fn((_name: string, value: any) => { command = value; }),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
	};
	const ctx: any = {
		mode: "rpc",
		hasUI: true,
		model: { provider: "test", id: "model", contextWindow: 10_000 },
		ui: { notify: vi.fn() },
		sessionManager: { buildContextEntries: vi.fn(() => []) },
		getSystemPromptOptions: vi.fn(() => ({ cwd: "/project", contextFiles: [], skills: [] })),
		getContextUsage: vi.fn(() => ({ tokens: 100, contextWindow: 10_000 })),
		getSystemPrompt: vi.fn(() => "system"),
	};
	contextDiagnosticsExtension(pi);
	return { pi, ctx, get command() { return command; } };
}

describe("context command", () => {
	it("registers only current-context diagnostics and rejects all arguments", async () => {
		const h = harness();
		expect(h.pi.registerCommand).toHaveBeenCalledWith("context", expect.any(Object));
		expect(h.command.description).toBe("Show model context usage and estimated breakdown");
		expect(h.command.getArgumentCompletions).toBeUndefined();

		await h.command.handler("global", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage: /context", "warning");
		expect(h.ctx.getSystemPromptOptions).not.toHaveBeenCalled();
	});

	it("keeps the non-TUI /context summary", async () => {
		const h = harness();
		await h.command.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("test/model"), "info");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("100 / 10k tokens"), "info");
	});
});
