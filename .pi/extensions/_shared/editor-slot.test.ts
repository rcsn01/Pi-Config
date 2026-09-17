import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	KeybindingsManager as TuiKeybindingsManager,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
	createSessionEditorLifetime,
	getEditorInputHandler,
	getModelCommandHandler,
	ModelCommandRoutingEditor,
	parseModelCommand,
	registerEditorInputHandler,
	registerModelCommandHandler,
	type EditorInputHandler,
	type ModelCommandHandler,
	type SessionEditorContribution,
} from "./editor-slot.ts";

// ---------------------------------------------------------------- harness ---

interface Harness {
	ctx: ExtensionContext;
	event: SessionStartEvent;
	setEditorComponent: ReturnType<typeof vi.fn>;
	getThinkingBorderColor: ReturnType<typeof vi.fn>;
	install: (contribution: SessionEditorContribution) => void;
	createLifetime: () => ReturnType<typeof createSessionEditorLifetime>;
	shutdown: () => Promise<void>;
	flush: () => Promise<void>;
}

const harnessCleanups: Array<() => void> = [];
const handlerCleanups: Array<() => void> = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	// Remove contributions while fake timers are still armed, so any re-flush
	// the removal schedules is a fake timer; the drain then fires it and the
	// registry's timer handle resets instead of leaking stale state.
	for (const cleanup of harnessCleanups.splice(0).reverse()) cleanup();
	await vi.runAllTimersAsync();
	vi.useRealTimers();
	for (const cleanup of handlerCleanups.splice(0).reverse()) cleanup();
});

function createHarness(): Harness {
	const setEditorComponent = vi.fn();
	const getThinkingBorderColor = vi.fn(() => (text: string) => `theme:${text}`);
	const ctx = {
		mode: "tui",
		thinkingLevel: "max",
		ui: {
			setEditorComponent,
			theme: { getThinkingBorderColor },
		},
	} as unknown as ExtensionContext;
	const event = { type: "session_start", reason: "startup" } as SessionStartEvent;
	const listeners = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const pi = {
		on: (type: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const handlers = listeners.get(type) ?? [];
			handlers.push(handler);
			listeners.set(type, handlers);
		},
	} as unknown as Pick<ExtensionAPI, "on">;
	const lifetimes: ReturnType<typeof createSessionEditorLifetime>[] = [];
	const createLifetime = () => {
		const lifetime = createSessionEditorLifetime(pi);
		lifetimes.push(lifetime);
		return lifetime;
	};
	const harness: Harness = {
		ctx,
		event,
		setEditorComponent,
		getThinkingBorderColor,
		install: (contribution) => createLifetime().install(event, ctx, contribution),
		createLifetime,
		shutdown: async () => {
			const shutdownEvent = { type: "session_shutdown", reason: "quit" };
			for (const handler of listeners.get("session_shutdown") ?? []) {
				await handler(shutdownEvent, ctx);
			}
		},
		// Run the deferred flush and drain the border microtasks it schedules.
		flush: async () => {
			await vi.runAllTimersAsync();
		},
	};
	harnessCleanups.push(() => {
		for (const lifetime of lifetimes) lifetime.dispose();
	});
	return harness;
}

function registerHandler(handler: ModelCommandHandler): () => void {
	const unregister = registerModelCommandHandler(handler);
	handlerCleanups.push(unregister);
	return unregister;
}

function registerInputHandler(handler: EditorInputHandler): () => void {
	const unregister = registerEditorInputHandler(handler);
	handlerCleanups.push(unregister);
	return unregister;
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

/** A minimal editor stand-in whose identity and border color are observable. */
function markerEditor(tag: string): EditorComponent {
	return {
		tag,
		borderColor: () => "copied-from-default-editor",
		handleInput: () => {},
		getText: () => "",
		setText: () => {},
		render: () => [],
		invalidate: () => {},
	} as unknown as EditorComponent;
}

function mount(setEditorComponent: ReturnType<typeof vi.fn>): EditorComponent {
	const factory = setEditorComponent.mock.calls.at(-1)?.[0];
	if (!factory) throw new Error("no editor factory was mounted");
	return factory(stubTui(), stubTheme(), createKeybindings());
}

// ------------------------------------------------------------------ tests ---

describe("model command handler registry", () => {
	it("exposes the registered handler and replaces it on re-register", () => {
		const first: ModelCommandHandler = async () => {};
		const second: ModelCommandHandler = async () => {};
		registerHandler(first);
		expect(getModelCommandHandler()).toBe(first);
		registerHandler(second);
		expect(getModelCommandHandler()).toBe(second);
	});

	it("does not let stale cleanup remove a newer active handler", () => {
		const first: ModelCommandHandler = async () => {};
		const second: ModelCommandHandler = async () => {};
		const unregisterFirst = registerHandler(first);
		registerHandler(second);
		unregisterFirst();
		expect(getModelCommandHandler()).toBe(second);
	});
});

describe("editor input handler registry", () => {
	it("exposes the registered handler and replaces it on re-register", () => {
		const first: EditorInputHandler = () => false;
		const second: EditorInputHandler = () => false;
		registerInputHandler(first);
		expect(getEditorInputHandler()).toBe(first);
		registerInputHandler(second);
		expect(getEditorInputHandler()).toBe(second);
	});

	it("does not let stale cleanup remove a newer active handler; the active unregister removes itself", () => {
		const first: EditorInputHandler = () => false;
		const second: EditorInputHandler = () => false;
		const unregisterFirst = registerInputHandler(first);
		const unregisterSecond = registerInputHandler(second);

		unregisterFirst();
		expect(getEditorInputHandler()).toBe(second);

		unregisterSecond();
		expect(getEditorInputHandler()).toBeUndefined();
	});
});

describe("parseModelCommand", () => {
	it("parses exact /model commands and preserves arguments", () => {
		expect(parseModelCommand("/model")).toBe("");
		expect(parseModelCommand("/model github-copilot/gpt-5.6-sol")).toBe(
			"github-copilot/gpt-5.6-sol",
		);
		expect(parseModelCommand("  /model  \n")).toBe("");
	});

	it("ignores similarly named commands, prose, and multiline prompts", () => {
		expect(parseModelCommand("/models")).toBeUndefined();
		expect(parseModelCommand("please run /model")).toBeUndefined();
		expect(parseModelCommand("/model\nthen continue")).toBeUndefined();
	});
});

describe("ModelCommandRoutingEditor", () => {
	function createRoutingEditor(handler?: ModelCommandHandler) {
		const onSubmit = vi.fn();
		const editor = new ModelCommandRoutingEditor(
			stubTui(),
			stubTheme(),
			createKeybindings(),
			handler,
		);
		editor.onSubmit = onSubmit;
		return { editor, onSubmit };
	}

	it("routes a standalone /model submit silently to the handler and clears the text", () => {
		const handler = vi.fn<(args: string) => Promise<void>>(async () => {});
		const { editor, onSubmit } = createRoutingEditor(handler);
		editor.setText("/model anthropic/claude-sonnet-4.6");
		editor.handleInput("\r");
		expect(handler).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
		expect(editor.getText()).toBe("");
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("routes a bare /model submit with empty arguments", () => {
		const handler = vi.fn<(args: string) => Promise<void>>(async () => {});
		const { editor, onSubmit } = createRoutingEditor(handler);
		editor.setText("/model");
		editor.handleInput("\r");
		expect(handler).toHaveBeenCalledWith("");
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("submits non-model text through the built-in path", () => {
		const handler = vi.fn<(args: string) => Promise<void>>(async () => {});
		const { editor, onSubmit } = createRoutingEditor(handler);
		editor.setText("hello world");
		editor.handleInput("\r");
		expect(handler).not.toHaveBeenCalled();
		expect(onSubmit).toHaveBeenCalledWith("hello world");
	});

	it("submits a multiline /model-looking prompt through the built-in path", () => {
		const handler = vi.fn<(args: string) => Promise<void>>(async () => {});
		const { editor, onSubmit } = createRoutingEditor(handler);
		editor.setText("/model\nthen continue");
		editor.handleInput("\r");
		expect(handler).not.toHaveBeenCalled();
		expect(onSubmit).toHaveBeenCalledWith("/model\nthen continue");
	});

	it("lets a subclass assign the handler after construction", () => {
		class LateBoundEditor extends ModelCommandRoutingEditor {
			attachHandler(handler: ModelCommandHandler): void {
				this.modelCommandHandler = handler;
			}
		}
		const handler = vi.fn<(args: string) => Promise<void>>(async () => {});
		const onSubmit = vi.fn();
		const editor = new LateBoundEditor(stubTui(), stubTheme(), createKeybindings());
		editor.onSubmit = onSubmit;

		// Before the handler arrives, submits flow through the built-in path.
		editor.setText("/model gpt-5.6-sol");
		editor.handleInput("\r");
		expect(handler).not.toHaveBeenCalled();
		expect(onSubmit).toHaveBeenCalledWith("/model gpt-5.6-sol");

		editor.attachHandler(handler);
		editor.setText("/model gpt-5.6-sol");
		editor.handleInput("\r");
		expect(handler).toHaveBeenCalledWith("gpt-5.6-sol");
		expect(editor.getText()).toBe("");
	});

	it("an editor constructed before handler registration sees the handler on the next keypress", () => {
		const { editor, onSubmit } = createRoutingEditor();
		editor.setText("hello");
		editor.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledTimes(1);

		const handler = vi.fn<EditorInputHandler>(() => false);
		registerInputHandler(handler);
		editor.setText("world");
		editor.handleInput("\r");
		expect(handler).toHaveBeenCalledWith("\r", editor);
		expect(onSubmit).toHaveBeenCalledTimes(2);
	});

	it("a handler returning true prevents /model routing and built-in submit", () => {
		const modelHandler = vi.fn<(args: string) => Promise<void>>(async () => {});
		registerHandler(modelHandler);
		const consumed = vi.fn<EditorInputHandler>(() => true);
		registerInputHandler(consumed);
		const { editor, onSubmit } = createRoutingEditor(modelHandler);

		editor.setText("/model gpt-5.6-sol");
		editor.handleInput("\r");
		expect(consumed).toHaveBeenCalledWith("\r", editor);
		expect(modelHandler).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("/model gpt-5.6-sol");
	});

	it("a handler returning false preserves /model routing and ordinary built-in input", () => {
		const modelHandler = vi.fn<(args: string) => Promise<void>>(async () => {});
		registerHandler(modelHandler);
		registerInputHandler(() => false);
		const { editor, onSubmit } = createRoutingEditor(modelHandler);

		editor.setText("/model gpt-5.6-sol");
		editor.handleInput("\r");
		expect(modelHandler).toHaveBeenCalledWith("gpt-5.6-sol");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");

		const { editor: plainEditor, onSubmit: plainSubmit } = createRoutingEditor(modelHandler);
		plainEditor.setText("hello world");
		plainEditor.handleInput("\r");
		expect(plainSubmit).toHaveBeenCalledWith("hello world");
	});
});

describe("session editor wave", () => {
	it("defers the install: nothing is written before the flush fires", () => {
		const harness = createHarness();
		harness.install({ id: "a", priority: 10, createEditor: () => markerEditor("a") });
		expect(harness.setEditorComponent).not.toHaveBeenCalled();
	});

	it("flushes once for a same-tick wave and mounts the highest-priority editor with the border reapplied", async () => {
		const harness = createHarness();
		const editorA = markerEditor("a");
		const editorB = markerEditor("b");
		harness.install({ id: "a", priority: 10, createEditor: () => editorA });
		harness.install({ id: "b", priority: 20, createEditor: () => editorB });

		await harness.flush();

		expect(harness.setEditorComponent).toHaveBeenCalledTimes(1);
		const mounted = mount(harness.setEditorComponent);
		expect(mounted).toBe(editorB);

		// Pi copies the default editor's border after the factory returns;
		// the module reapply must win that race.
		mounted.borderColor = () => "copied-from-default-editor";
		await Promise.resolve();
		expect(mounted.borderColor?.("─")).toBe("theme:─");
		expect(harness.getThinkingBorderColor).toHaveBeenCalledWith("max");
	});

	it("replaces a re-registered contribution and remounts it", async () => {
		const harness = createHarness();
		const first = markerEditor("a1");
		const second = markerEditor("a2");
		harness.install({ id: "a", priority: 10, createEditor: () => first });
		harness.install({ id: "a", priority: 20, createEditor: () => second });

		await harness.flush();

		expect(harness.setEditorComponent).toHaveBeenCalledTimes(1);
		expect(mount(harness.setEditorComponent)).toBe(second);
	});

	it("breaks priority ties by latest registration", async () => {
		const harness = createHarness();
		const editorA = markerEditor("a");
		const editorB = markerEditor("b");
		harness.install({ id: "a", priority: 5, createEditor: () => editorA });
		harness.install({ id: "b", priority: 5, createEditor: () => editorB });

		await harness.flush();

		expect(mount(harness.setEditorComponent)).toBe(editorB);
	});

	it("re-flushes when a higher-priority contributor registers after the flush fired", async () => {
		const harness = createHarness();
		const editorLow = markerEditor("low");
		const editorHigh = markerEditor("high");
		harness.install({ id: "low", priority: 10, createEditor: () => editorLow });
		await harness.flush();
		expect(harness.setEditorComponent).toHaveBeenCalledTimes(1);
		expect(mount(harness.setEditorComponent)).toBe(editorLow);

		// The common production path: the low-priority contributor crosses a
		// macrotask boundary before the high-priority one registers.
		harness.install({ id: "high", priority: 20, createEditor: () => editorHigh });
		await harness.flush();
		expect(harness.setEditorComponent).toHaveBeenCalledTimes(2);
		expect(mount(harness.setEditorComponent)).toBe(editorHigh);
	});
});

describe("SessionEditorLifetime", () => {
	it("automatically restores Pi's editor on repeated shutdown", async () => {
		const harness = createHarness();
		harness.install({ id: "owned", priority: 10, createEditor: () => markerEditor("owned") });
		await harness.flush();

		await harness.shutdown();
		await harness.shutdown();

		expect(harness.setEditorComponent).toHaveBeenLastCalledWith(undefined);
		expect(harness.setEditorComponent).toHaveBeenCalledTimes(2);
	});

	it("cancels a deferred factory when shutdown happens before the flush", async () => {
		const harness = createHarness();
		const createEditor = vi.fn(() => markerEditor("owned"));
		harness.install({ id: "owned", priority: 10, createEditor });

		await harness.shutdown();
		await harness.flush();

		expect(createEditor).not.toHaveBeenCalled();
		expect(harness.setEditorComponent).toHaveBeenCalledOnce();
		expect(harness.setEditorComponent).toHaveBeenCalledWith(undefined);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not let stale cleanup delete a newer Session's same-id entry", async () => {
		const first = createHarness();
		const second = createHarness();
		const firstLifetime = first.createLifetime();
		const secondLifetime = second.createLifetime();
		const newer = markerEditor("newer");
		firstLifetime.install(first.event, first.ctx, {
			id: "history",
			priority: 20,
			createEditor: () => markerEditor("older"),
		});
		secondLifetime.install(second.event, second.ctx, {
			id: "history",
			priority: 20,
			createEditor: () => newer,
		});

		firstLifetime.dispose();
		await second.flush();

		expect(mount(second.setEditorComponent)).toBe(newer);
		secondLifetime.dispose();
		expect(second.setEditorComponent).toHaveBeenLastCalledWith(undefined);
	});

	it("replaces one lifetime atomically and ignores cleanup from an overwritten lifetime", async () => {
		const harness = createHarness();
		const staleLifetime = harness.createLifetime();
		const activeLifetime = harness.createLifetime();
		staleLifetime.install(harness.event, harness.ctx, {
			id: "selector",
			priority: 10,
			createEditor: () => markerEditor("stale"),
		});
		activeLifetime.install(harness.event, harness.ctx, {
			id: "selector",
			priority: 10,
			createEditor: () => markerEditor("first"),
		});
		staleLifetime.dispose();
		const latest = markerEditor("latest");
		activeLifetime.install(harness.event, harness.ctx, {
			id: "selector",
			priority: 10,
			createEditor: () => latest,
		});

		expect(harness.setEditorComponent).not.toHaveBeenCalled();
		await harness.flush();
		expect(harness.setEditorComponent).toHaveBeenCalledOnce();
		expect(mount(harness.setEditorComponent)).toBe(latest);
	});

	it("invalidates the prior Session timer when a new wave starts", async () => {
		const first = createHarness();
		const second = createHarness();
		const firstFactory = vi.fn(() => markerEditor("first"));
		const secondFactory = vi.fn(() => markerEditor("second"));
		first.install({ id: "first", priority: 20, createEditor: firstFactory });
		expect(vi.getTimerCount()).toBe(1);
		second.install({ id: "second", priority: 20, createEditor: secondFactory });
		expect(vi.getTimerCount()).toBe(1);

		await second.flush();

		expect(firstFactory).not.toHaveBeenCalled();
		expect(first.setEditorComponent).not.toHaveBeenCalled();
		expect(second.setEditorComponent).toHaveBeenCalledOnce();
		mount(second.setEditorComponent);
		expect(secondFactory).toHaveBeenCalledOnce();
	});

	it("remounts the remaining contributor when the winner is disposed", async () => {
		const harness = createHarness();
		const selectorLifetime = harness.createLifetime();
		const historyLifetime = harness.createLifetime();
		const selector = markerEditor("selector");
		const history = markerEditor("history");
		selectorLifetime.install(harness.event, harness.ctx, {
			id: "selector",
			priority: 10,
			createEditor: () => selector,
		});
		historyLifetime.install(harness.event, harness.ctx, {
			id: "history",
			priority: 20,
			createEditor: () => history,
		});
		await harness.flush();
		expect(mount(harness.setEditorComponent)).toBe(history);

		historyLifetime.dispose();
		expect(harness.setEditorComponent).toHaveBeenCalledTimes(1);
		await harness.flush();

		expect(harness.setEditorComponent).toHaveBeenCalledTimes(2);
		expect(mount(harness.setEditorComponent)).toBe(selector);
		selectorLifetime.dispose();
		expect(harness.setEditorComponent).toHaveBeenLastCalledWith(undefined);
	});

	it("contains restoration failures after the TUI is torn down", async () => {
		const harness = createHarness();
		const lifetime = harness.createLifetime();
		lifetime.install(harness.event, harness.ctx, {
			id: "owned",
			priority: 10,
			createEditor: () => markerEditor("owned"),
		});
		await harness.flush();
		harness.setEditorComponent.mockImplementation((factory) => {
			if (factory === undefined) throw new Error("TUI disposed");
		});

		expect(() => lifetime.dispose()).not.toThrow();
		expect(() => lifetime.dispose()).not.toThrow();
	});
});
