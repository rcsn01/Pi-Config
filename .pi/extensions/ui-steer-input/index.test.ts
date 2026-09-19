import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
	createSessionEditorLifetime,
	getEditorInputHandler,
	ModelCommandRoutingEditor,
	type EditorInputHandler,
	type ModelCommandHandler,
} from "../_shared/editor-slot.ts";
import steerInputExtension from "./index.ts";

// ---------------------------------------------------------------- harness ---

type Handler = (event: unknown, ctx: unknown) => unknown;

type SessionLifetime = ReturnType<typeof createSessionEditorLifetime>;

interface SteerHarness {
	handlers: Map<string, Handler[]>;
	sessionStartEvent: SessionStartEvent;
	createLifetime: () => SessionLifetime;
	sendUserMessage: ReturnType<typeof vi.fn>;
	ctx: {
		mode: "tui" | "rpc";
		thinkingLevel: string;
		ui: {
			setWidget: ReturnType<typeof vi.fn>;
			setEditorComponent: ReturnType<typeof vi.fn>;
			getEditorComponent: ReturnType<typeof vi.fn>;
			setEditorText: ReturnType<typeof vi.fn>;
			notify: ReturnType<typeof vi.fn>;
			theme: { getThinkingBorderColor: () => (text: string) => string };
		};
	};
	fire: (event: string, eventArg?: unknown) => Promise<void>;
}

const createdInstances: SteerHarness[] = [];

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function stubTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

function stubTheme(): EditorTheme {
	return { borderColor: (text: string) => text } as unknown as EditorTheme;
}

function createKeybindings(): KeybindingsManager {
	return new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
}

function createHarness(mode: "tui" | "rpc" = "tui"): SteerHarness {
	const handlers = new Map<string, Handler[]>();
	const sendUserMessage = vi.fn();
	const pi = {
		on: (event: string, handler: Handler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		sendUserMessage,
	} as any;
	steerInputExtension(pi);
	const ctx = {
		mode,
		thinkingLevel: "max",
		ui: {
			setWidget: vi.fn(),
			setEditorComponent: vi.fn(),
			getEditorComponent: vi.fn(),
			setEditorText: vi.fn(),
			notify: vi.fn(),
			theme: { getThinkingBorderColor: () => (text: string) => text },
		},
	} as SteerHarness["ctx"];
	const harness: SteerHarness = {
		handlers,
		sessionStartEvent: { type: "session_start", reason: "startup" } as SessionStartEvent,
		createLifetime: () => createSessionEditorLifetime(pi),
		sendUserMessage,
		ctx,
		fire: async (event: string, eventArg?: unknown) => {
			const payload = eventArg ?? {};
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
	};
	createdInstances.push(harness);
	return harness;
}

/** Construct the session editor the test drives, mirroring what Pi mounts. */
function createEditor(modelCommandHandler?: ModelCommandHandler) {
	const editor = new ModelCommandRoutingEditor(stubTui(), stubTheme(), createKeybindings(), modelCommandHandler);
	return {
		editor,
		onSubmit: vi.fn<(text: string) => void>(),
	};
}

afterEach(async () => {
	// Shut instances down in reverse creation order so the newest Session wave
	// is disposed first; every registered shutdown listener must run.
	for (const harness of createdInstances.splice(0).reverse()) {
		await harness.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
	}
});

// ------------------------------------------------------------------ tests ---

describe("steer widget", () => {
	it("shows a themed, width-safe hint while the agent is streaming", async () => {
		const harness = createHarness();
		await harness.fire("agent_start");
		expect(harness.ctx.ui.setWidget).toHaveBeenCalledWith("steer-hint", expect.any(Function));

		const factory = harness.ctx.ui.setWidget.mock.calls.at(-1)?.[1];
		const widget = factory({}, theme());
		for (const width of [20, 40, 80]) {
			const lines = widget.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		const output = widget.render(80)[0] ?? "";
		expect(output).toContain("Enter");
		expect(output).toContain("Tab");
		expect(output).toContain(" · ");
	});

	it("clears the hint when the agent finishes streaming", async () => {
		const harness = createHarness();
		await harness.fire("agent_start");
		await harness.fire("agent_end");
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("steer-hint", undefined);
	});
});

describe("editor slot is untouched", () => {
	it("no lifecycle handler reads or writes the editor slot", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_start");
		await harness.fire("agent_end");
		await harness.fire("session_shutdown");
		expect(harness.ctx.ui.setEditorComponent).not.toHaveBeenCalled();
		expect(harness.ctx.ui.getEditorComponent).not.toHaveBeenCalled();
	});

	it("non-TUI session_start does not install the input handler", async () => {
		const harness = createHarness("rpc");
		await harness.fire("session_start");
		expect(getEditorInputHandler()).toBeUndefined();
	});
});

describe("input handler registration", () => {
	it("session_start registers and session_shutdown unregisters the handler", async () => {
		const harness = createHarness();
		expect(getEditorInputHandler()).toBeUndefined();
		await harness.fire("session_start");
		expect(getEditorInputHandler()).toBeDefined();
		await harness.fire("session_shutdown");
		expect(getEditorInputHandler()).toBeUndefined();
	});

	it("session_shutdown clears the hint and the local slash queue", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_start");
		const { editor, onSubmit } = createEditor();
		editor.onSubmit = onSubmit;

		editor.setText("/queued");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("");

		await harness.fire("session_shutdown");
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("steer-hint", undefined);

		// The queue was cleared, not drained: nothing restores or submits.
		await harness.fire("agent_end");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setEditorText).not.toHaveBeenCalled();
	});

	it("session_shutdown cannot remove a newer replacement instance's handler", async () => {
		const first = createHarness();
		await first.fire("session_start");
		const firstHandler = getEditorInputHandler();

		const second = createHarness();
		await second.fire("session_start");
		expect(getEditorInputHandler()).not.toBe(firstHandler);

		await first.fire("session_shutdown");
		expect(getEditorInputHandler()).toBeDefined();
	});
});

describe("Tab interception while streaming", () => {
	function tabCompletionSpy(editor: ModelCommandRoutingEditor): ReturnType<typeof vi.fn> {
		return vi.spyOn(editor as unknown as { handleTabCompletion: () => void }, "handleTabCompletion");
	}

	it("idle Tab falls through to normal editor handling", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		const { editor, onSubmit } = createEditor();
		editor.onSubmit = onSubmit;
		editor.setText("draft");
		const tabCompletion = tabCompletionSpy(editor);

		editor.handleInput("\t");

		expect(tabCompletion).toHaveBeenCalled(); // built-in path ran
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setEditorText).not.toHaveBeenCalled();
	});

	it("active empty and whitespace-only Tab are consumed without clearing or queueing", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_start");
		const { editor } = createEditor();
		const tabCompletion = tabCompletionSpy(editor);

		editor.setText("   ");
		editor.handleInput("\t");
		expect(tabCompletion).not.toHaveBeenCalled(); // handler consumed the key
		expect(editor.getText()).toBe("   ");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();

		editor.setText("");
		editor.handleInput("\t");
		expect(tabCompletion).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("active non-slash Tab sends one followUp, records once, clears, and notifies without submitting", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_start");
		const { editor, onSubmit } = createEditor();
		editor.onSubmit = onSubmit;
		const addToHistory = vi.spyOn(editor, "addToHistory");
		const setText = vi.spyOn(editor, "setText");

		editor.setText("follow up text");
		harness.ctx.ui.notify.mockClear(); // ignore any pre-Tab notifications
		editor.handleInput("\t");

		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(harness.sendUserMessage).toHaveBeenCalledWith("follow up text", { deliverAs: "followUp" });
		expect(addToHistory).toHaveBeenCalledTimes(1);
		expect(addToHistory).toHaveBeenCalledWith("follow up text");
		expect(editor.getText()).toBe("");
		expect(harness.ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
		// The entry is recorded before the editor is cleared.
		expect(addToHistory.mock.invocationCallOrder[0]).toBeLessThan(setText.mock.invocationCallOrder.at(-1)!);
	});

	it("active slash Tab does not execute immediately, records once, then drains through the captured submit on agent_end", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_start");
		const { editor, onSubmit } = createEditor();
		editor.onSubmit = onSubmit;
		const addToHistory = vi.spyOn(editor, "addToHistory");

		editor.setText("/do-thing");
		editor.handleInput("\t");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(addToHistory).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");

		await harness.fire("agent_end");
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("/do-thing");
	});

	it("multiple slash commands drain FIFO and a re-entrant drain cannot repeat the batch", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_start");
		const { editor } = createEditor();
		const drained: string[] = [];
		editor.onSubmit = (text) => {
			drained.push(text);
			if (text === "/first") void harness.fire("agent_end"); // callback re-enters the drain
		};

		editor.setText("/first");
		editor.handleInput("\t");
		editor.setText("/second");
		editor.handleInput("\t");

		await harness.fire("agent_end");
		expect(drained).toEqual(["/first", "/second"]);
	});

	it("a queued /model drains through the registered model handler, not the generic submit", async () => {
		const modelHandler = vi.fn<(args: string) => Promise<void>>(async () => {});
		const harness = createHarness();
		const modelLifetime = harness.createLifetime();
		modelLifetime.install(harness.sessionStartEvent, harness.ctx as any, {
			id: "test-model-handler",
			modelCommandHandler: modelHandler,
		});
		await harness.fire("session_start", harness.sessionStartEvent);
		await harness.fire("agent_start");
		const { editor, onSubmit } = createEditor();
		editor.onSubmit = onSubmit;

		editor.setText("/model gpt-5.6-sol");
		editor.handleInput("\t");
		expect(modelHandler).not.toHaveBeenCalled();

		await harness.fire("agent_end");
		expect(modelHandler).toHaveBeenCalledWith("gpt-5.6-sol");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setEditorText).not.toHaveBeenCalled();
	});

	it("a missing submit callback restores the command with setEditorText and notifies", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_start");
		const { editor } = createEditor();
		editor.onSubmit = undefined;

		editor.setText("/mystery");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("");

		await harness.fire("agent_end");
		expect(harness.ctx.ui.setEditorText).toHaveBeenCalledWith("/mystery");
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("restored to editor"),
			"info",
		);
	});

	it("Enter is not intercepted and continues through normal submit handling", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_start");
		const { editor, onSubmit } = createEditor();
		editor.onSubmit = onSubmit;

		editor.setText("plain steering text");
		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("plain steering text");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setEditorText).not.toHaveBeenCalled();
	});
});

describe("steer notification", () => {
	it("notifies when an Enter steer arrives while streaming", async () => {
		const harness = createHarness();
		await harness.fire("agent_start");
		await harness.fire("input", { text: "steer", streamingBehavior: "steer" });
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Steering agent...", "info");
	});

	it("ignores input events while idle", async () => {
		const harness = createHarness();
		await harness.fire("input", { text: "steer", streamingBehavior: "steer" });
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("/model routing through the editor-slot registry", () => {
	it("routes an Enter /model submit to the registered handler while streaming", async () => {
		const handler = vi.fn<(args: string) => Promise<void>>(async () => {});
		const harness = createHarness();
		const modelLifetime = harness.createLifetime();
		modelLifetime.install(harness.sessionStartEvent, harness.ctx as any, {
			id: "test-model-handler",
			modelCommandHandler: handler,
		});
		await harness.fire("session_start", harness.sessionStartEvent);
		await harness.fire("agent_start");

		const editor = new ModelCommandRoutingEditor(stubTui(), stubTheme(), createKeybindings(), handler);
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;
		editor.setText("/model anthropic/claude-sonnet-4.6");
		editor.handleInput("\r");

		expect(handler).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
		expect(editor.getText()).toBe("");
		expect(onSubmit).not.toHaveBeenCalled();
	});
});