import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { registerModelCommandHandler, type ModelCommandHandler } from "../_shared/editor-slot.ts";
import steerInputExtension from "./index.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function createKeybindings(): KeybindingsManager {
	return new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
}

interface SteerHarness {
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	ctx: {
		hasUI: boolean;
		ui: {
			setWidget: ReturnType<typeof vi.fn>;
			setEditorComponent: ReturnType<typeof vi.fn>;
			getEditorComponent: ReturnType<typeof vi.fn>;
			setEditorText: ReturnType<typeof vi.fn>;
			notify: ReturnType<typeof vi.fn>;
		};
	};
	/** Mount the editor the extension swapped in during streaming. */
	mountSteerEditor: () => unknown;
}

function createSteerHarness(): SteerHarness {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const setEditorComponent = vi.fn();
	const getEditorComponent = vi.fn();
	const ctx = {
		hasUI: true,
		thinkingLevel: "max",
		ui: {
			setWidget: vi.fn(),
			setEditorComponent,
			getEditorComponent,
			setEditorText: vi.fn(),
			notify: vi.fn(),
			theme: { getThinkingBorderColor: vi.fn(() => (text: string) => text) },
		},
	} as any;
	steerInputExtension({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		sendUserMessage: vi.fn(),
	} as any);
	return {
		handlers,
		ctx,
		mountSteerEditor: () => {
			const factory = setEditorComponent.mock.calls.at(-1)?.[0];
			if (!factory) throw new Error("steer editor was not installed");
			return factory(
				{ requestRender: vi.fn() } as unknown as TUI,
				{ borderColor: (text: string) => text } as unknown as EditorTheme,
				createKeybindings(),
			);
		},
	};
}

const handlerUnregisters: Array<() => void> = [];

afterEach(() => {
	for (const unregister of handlerUnregisters.splice(0)) unregister();
});

describe("steer widget", () => {
	it("shows a themed, width-safe hint while the agent is streaming", () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const setWidget = vi.fn();
		steerInputExtension({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			sendUserMessage: vi.fn(),
		} as any);

		const ctx = {
			hasUI: true,
			ui: {
				setWidget,
				setEditorComponent: vi.fn(),
				getEditorComponent: vi.fn(),
				setEditorText: vi.fn(),
				notify: vi.fn(),
			},
		} as any;

		handlers.get("agent_start")!({}, ctx);
		expect(setWidget).toHaveBeenCalledWith("steer-hint", expect.any(Function));

		const factory = setWidget.mock.calls.at(-1)?.[1];
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
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const setWidget = vi.fn();
		steerInputExtension({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			sendUserMessage: vi.fn(),
		} as any);

		const ctx = {
			hasUI: true,
			ui: {
				setWidget,
				setEditorComponent: vi.fn(),
				getEditorComponent: vi.fn(),
				setEditorText: vi.fn(),
				notify: vi.fn(),
			},
		} as any;

		handlers.get("agent_start")!({}, ctx);
		const agentEnd = handlers.get("agent_end")!;
		await agentEnd({}, ctx);
		expect(setWidget).toHaveBeenLastCalledWith("steer-hint", undefined);
	});
});

describe("/model routing through the editor-slot registry", () => {
	it("routes an Enter /model submit to the registered handler while streaming", async () => {
		const handler = vi.fn<(args: string) => Promise<void>>(async () => {});
		handlerUnregisters.push(registerModelCommandHandler(handler));
		const harness = createSteerHarness();
		await harness.handlers.get("agent_start")!({}, harness.ctx);

		const editor = harness.mountSteerEditor() as unknown as {
			setText(text: string): void;
			handleInput(data: string): void;
			getText(): string;
			onSubmit?: (text: string) => void;
		};
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;
		editor.setText("/model anthropic/claude-sonnet-4.6");
		editor.handleInput("\r");

		expect(handler).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
		expect(editor.getText()).toBe("");
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("routes a queued /model command to the registered handler, not the generic submit", async () => {
		const handler = vi.fn<(args: string) => Promise<void>>(async () => {});
		handlerUnregisters.push(registerModelCommandHandler(handler));
		const harness = createSteerHarness();
		await harness.handlers.get("agent_start")!({}, harness.ctx);

		const editor = harness.mountSteerEditor() as unknown as {
			setText(text: string): void;
			handleInput(data: string): void;
			onSubmit?: (text: string) => void;
		};
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;
		editor.setText("/model gpt-5.6-sol");
		editor.handleInput("\t"); // queue the slash command while streaming

		expect(handler).not.toHaveBeenCalled();
		await harness.handlers.get("agent_end")!({}, harness.ctx);
		expect(handler).toHaveBeenCalledWith("gpt-5.6-sol");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setEditorText).not.toHaveBeenCalled();
	});
});
