/**
 * Cross-extension regression test: the real PreviousMessageEditor mounted by
 * ui-message-history's session contribution plus the real ui-steer-input
 * input-handler registration, on one editor instance.
 *
 * The history store's file boundary (its `file` argument) is redirected into
 * a throwaway directory so the test never touches the user's home directory.
 *
 * This suite exists because the store-only tests cannot catch an editor
 * replacement regression: if any extension swapped the mounted editor again,
 * Tab-queued and Ctrl+C text would silently stop reaching persistent
 * history, and Up recall would break while streaming.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	KeybindingsManager as TuiKeybindingsManager,
	TUI_KEYBINDINGS,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { getEditorInputHandler, removeSessionEditor } from "../_shared/editor-slot.ts";
import messageHistoryExtension from "./index.ts";
import steerInputExtension from "../ui-steer-input/index.ts";

// Redirect the history store's file boundary into a throwaway directory.
const storeDir = vi.hoisted(() => ({ dir: "" }));
vi.mock("./history-store.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./history-store.ts")>();
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	storeDir.dir = mkdtempSync(join(tmpdir(), "steer-recall-"));
	return {
		createHistoryStore: (args: { file: string }) =>
			actual.createHistoryStore({ file: join(storeDir.dir, "previous-message-history.json") }),
	};
});

afterAll(() => {
	if (storeDir.dir) rmSync(storeDir.dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ harness ---

type Handler = (event: unknown, ctx: unknown) => unknown;

interface SessionHarness {
	pi: {
		fire: (event: string, eventArg?: unknown) => Promise<void>;
		sendUserMessage: ReturnType<typeof vi.fn>;
	};
	ctx: Record<string, unknown>;
	editor: {
		getText(): string;
		setText(text: string): void;
		handleInput(data: string): void;
		addToHistory(text: string): void;
		onSubmit?: (text: string) => void;
		onAction(action: string, handler: () => void): void;
	};
	cwd: string;
}

let cwdSequence = 0;

function stubTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

function stubTheme(): EditorTheme {
	return { borderColor: (text: string) => text } as unknown as EditorTheme;
}

/** App-level keybindings: TUI bindings plus the app actions the editor consumes. */
function createAppKeybindings(): KeybindingsManager {
	return new TuiKeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
		"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
		"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
		// The dedicated history bindings ship unbound; bind one so the test can
		// enter rollback mode from a nonblank draft, the way keybindings.json users do.
		"tui.editor.historyPrevious": { defaultKeys: "ctrl+r", description: "Select previous prompt history entry" },
	}) as unknown as KeybindingsManager;
}

async function createSession(): Promise<SessionHarness> {
	const listeners = new Map<string, Handler[]>();
	const register = (event: string, handler: Handler) => {
		const existing = listeners.get(event);
		if (existing) existing.push(handler);
		else listeners.set(event, [handler]);
	};
	const sendUserMessage = vi.fn();
	const pi = { on: register, sendUserMessage } as never;

	messageHistoryExtension(pi);
	steerInputExtension(pi);

	const ctx = {
		mode: "tui",
		cwd: `/tmp/steer-recall-${++cwdSequence}`,
		thinkingLevel: "max",
		ui: {
			setWidget: vi.fn(),
			setEditorComponent: vi.fn(),
			getEditorComponent: vi.fn(),
			setEditorText: vi.fn(),
			notify: vi.fn(),
			theme: { getThinkingBorderColor: () => (text: string) => text },
		},
	};

	const fire = async (event: string, eventArg?: unknown) => {
		for (const handler of listeners.get(event) ?? []) {
			await handler(eventArg ?? {}, ctx);
		}
	};

	await fire("session_start");

	// The editor-slot wave mounts the winner through a deferred macrotask.
	await new Promise((resolve) => setTimeout(resolve, 0));

	const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
	if (!factory) throw new Error("no session editor was mounted");
	const editor = factory(stubTui(), stubTheme(), createAppKeybindings()) as SessionHarness["editor"];

	return {
		pi: { fire, sendUserMessage },
		ctx,
		editor,
		cwd: ctx.cwd as string,
	};
}

async function disposeSession(session: SessionHarness): Promise<void> {
	await session.pi.fire("session_shutdown");
	removeSessionEditor(session.ctx as never, "ui-message-history");
}

afterEach(async () => {
	expect(getEditorInputHandler()).toBeUndefined(); // every test must clean up its handler
});

const UP = "\x1b[A";
const DOWN = "\x1b[B";

// -------------------------------------------------------------------- tests ---

describe("steer input keeps the mounted history editor recallable", () => {
	it("Up recalls a store entry before and during agent streaming; Up with no entries is a no-op", async () => {
		const session = await createSession();
		const { editor } = session;

		// No entries yet: Up does nothing.
		editor.handleInput(UP);
		expect(editor.getText()).toBe("");

		// Record through the real editor path: addToHistory → store.record.
		editor.addToHistory("entry-1");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("entry-1");
		editor.handleInput(DOWN);
		expect(editor.getText()).toBe("");

		// The same mounted editor still recalls while the agent streams.
		await session.pi.fire("agent_start");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("entry-1");
		editor.handleInput(DOWN);
		expect(editor.getText()).toBe("");

		await disposeSession(session);
	});

	it("Enter while active reaches the history editor's addToHistory through Pi's submit callback", async () => {
		const session = await createSession();
		const { editor } = session;

		// Pi's interactive submit handler records via the mounted editor.
		editor.onSubmit = (text: string) => {
			editor.addToHistory(text);
			editor.setText("");
		};

		await session.pi.fire("agent_start");
		editor.setText("steered message");
		editor.handleInput("\r");

		expect(editor.getText()).toBe("");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("steered message");

		await disposeSession(session);
	});

	it("Tab follow-up and slash-command paths record through the history editor before clearing", async () => {
		const session = await createSession();
		const { editor } = session;
		const submitted: string[] = [];
		editor.onSubmit = (text: string) => {
			editor.addToHistory(text);
			submitted.push(text);
			editor.setText("");
		};

		await session.pi.fire("agent_start");

		editor.setText("tab follow-up");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("");
		expect(session.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(session.pi.sendUserMessage).toHaveBeenCalledWith("tab follow-up", { deliverAs: "followUp" });

		editor.setText("/deploy now");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("");
		expect(submitted).toEqual([]); // queued, not executed while streaming

		// Both Tab entries were recorded at queue time, newest first.
		editor.handleInput(UP);
		expect(editor.getText()).toBe("/deploy now");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("tab follow-up");
		editor.handleInput(DOWN);
		editor.handleInput(DOWN);
		expect(editor.getText()).toBe(""); // past the newest entry: pre-rollback draft

		await session.pi.fire("agent_end");
		expect(submitted).toEqual(["/deploy now"]);

		await disposeSession(session);
	});

	it("Ctrl+C while active records the current text", async () => {
		const session = await createSession();
		const { editor } = session;
		// Pi's app action clears the editor; without it Ctrl+C is a no-op.
		editor.onAction("app.clear", () => editor.setText(""));

		await session.pi.fire("agent_start");
		editor.setText("dismissed draft");
		editor.handleInput("\x03"); // Ctrl+C

		expect(editor.getText()).toBe("");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("dismissed draft");

		await disposeSession(session);
	});

	it("Down restores the pre-rollback draft after a mid-stream recall", async () => {
		const session = await createSession();
		const { editor } = session;
		editor.addToHistory("old entry");

		await session.pi.fire("agent_start");
		// The dedicated history binding (bindable via keybindings.json) enters
		// rollback mode even from a nonblank draft; plain ↑ in nonblank text
		// stays cursor movement.
		editor.setText("my draft in progress");
		editor.handleInput("\x12");
		expect(editor.getText()).toBe("old entry");
		editor.handleInput(DOWN);
		expect(editor.getText()).toBe("my draft in progress");

		await disposeSession(session);
	});

	it("recorded entries persist through the real store file after shutdown", async () => {
		const session = await createSession();
		const { editor } = session;
		editor.addToHistory("persisted entry");

		await disposeSession(session);

		const persisted = JSON.parse(
			readFileSync(join(storeDir.dir, "previous-message-history.json"), "utf8"),
		) as Record<string, string[]>;
		expect(persisted[session.cwd]).toEqual(["persisted entry"]);
	});
});