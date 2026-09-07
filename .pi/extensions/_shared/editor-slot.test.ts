import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	KeybindingsManager as TuiKeybindingsManager,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
	getModelCommandHandler,
	installSessionEditor,
	ModelCommandRoutingEditor,
	parseModelCommand,
	registerModelCommandHandler,
	removeSessionEditor,
	type ModelCommandHandler,
	type SessionEditorContribution,
} from "./editor-slot.ts";

// ---------------------------------------------------------------- harness ---

interface Harness {
	ctx: ExtensionContext;
	setEditorComponent: ReturnType<typeof vi.fn>;
	getThinkingBorderColor: ReturnType<typeof vi.fn>;
	install: (contribution: SessionEditorContribution) => void;
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
	const ids: string[] = [];
	const harness: Harness = {
		ctx,
		setEditorComponent,
		getThinkingBorderColor,
		install: (contribution) => {
			installSessionEditor(ctx, contribution);
			ids.push(contribution.id);
		},
		// Run the deferred flush and drain the border microtasks it schedules.
		flush: async () => {
			await vi.runAllTimersAsync();
		},
	};
	harnessCleanups.push(() => {
		for (const id of ids.splice(0)) removeSessionEditor(ctx, id);
	});
	return harness;
}

function registerHandler(handler: ModelCommandHandler): () => void {
	const unregister = registerModelCommandHandler(handler);
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

describe("removeSessionEditor", () => {
	it("restores Pi's built-in editor when the last contributor is removed", async () => {
		const harness = createHarness();
		harness.install({ id: "a", priority: 10, createEditor: () => markerEditor("a") });
		await harness.flush();
		expect(harness.setEditorComponent).toHaveBeenCalledTimes(1);

		removeSessionEditor(harness.ctx, "a");
		expect(harness.setEditorComponent).toHaveBeenLastCalledWith(undefined);
	});

	it("re-flushes so the remaining contributor remounts", async () => {
		const harness = createHarness();
		const editorA = markerEditor("a");
		const editorB = markerEditor("b");
		harness.install({ id: "a", priority: 10, createEditor: () => editorA });
		harness.install({ id: "b", priority: 20, createEditor: () => editorB });
		await harness.flush();

		removeSessionEditor(harness.ctx, "b");
		await harness.flush();

		expect(harness.setEditorComponent).toHaveBeenCalledTimes(2);
		expect(mount(harness.setEditorComponent)).toBe(editorA);
	});

	it("is a no-op for an unknown id", () => {
		const harness = createHarness();
		removeSessionEditor(harness.ctx, "never-registered");
		expect(harness.setEditorComponent).not.toHaveBeenCalled();
	});
});