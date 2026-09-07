/**
 * previous-message — Up-arrow recall of previous messages and commands.
 *
 * Press ↑ in a blank chatbox to bring back the previous message or command,
 * press ↑ again to walk further back through history, and ↓ to walk forward
 * again (past the newest entry it restores what you had typed before, usually
 * blank). Text dismissed with Ctrl+C is remembered too, and history is
 * persisted per project across restarts.
 *
 * Rollback mode stops as soon as you edit the text or move the cursor —
 * ↑/↓ then act as normal cursor movement again.
 *
 * History is stored per working directory in
 * `~/.pi/agent/previous-message-history.json` (machine-local, deliberately
 * not synced, so the hot history file doesn't churn a synced config repo).
 *
 * Design notes:
 * - A `pi.registerShortcut("up", …)` can't work here: the TUI always consumes
 *   the key when a shortcut matches, so we could never pass cursor-up through
 *   for multiline text. Instead we install a `CustomEditor` subclass, which
 *   the TUI wires up with all app actions (Ctrl+C, escape, …) automatically.
 * - The built-in editor already navigates an in-memory history, but it misses
 *   Ctrl+C-dismissed text, isn't persisted, and keeps browsing after cursor
 *   movement. This subclass owns the whole recall UX instead.
 * - Editor ownership is delegated to the editor-slot module
 *   (`_shared/editor-slot.ts`): this extension registers a contributor
 *   (`{id, priority, createEditor}`) for the session_start wave and the
 *   module mounts the highest-priority contributor's editor, reapplying the
 *   thinking border itself. ui-model-selector contributes the /model routing
 *   handler (registry) and the routing editor base class through the same
 *   module, so the winner inherits silent /model routing without any probe
 *   into other extensions' editors and without any reclaim timing.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	getModelCommandHandler,
	installSessionEditor,
	ModelCommandRoutingEditor,
	type ModelCommandHandler,
} from "../_shared/editor-slot.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHistoryStore } from "./history-store.ts";

function historyFile(): string {
	return join(homedir(), ".pi", "agent", "previous-message-history.json");
}

const store = createHistoryStore({ file: historyFile() });

/**
 * Editor that adds rollback-mode history navigation on ↑/↓.
 *
 * - ↑ in a blank editor enters rollback mode and recalls the previous entry;
 * - ↑ again walks further back; ↓ walks forward; past the newest entry the
 *   pre-rollback text (usually blank) is restored;
 * - the first edit or cursor movement exits rollback mode, so ↑/↓ behave as
 *   normal cursor movement again;
 * - `tui.editor.historyPrevious` / `tui.editor.historyNext` bindings (from
 *   keybindings.json) map onto the same navigation;
 * - Ctrl+C (app.clear) snapshots the current text into history before the
 *   built-in handler clears it;
 * - a `/model` handler (from the editor-slot registry, attached later) makes
 *   standalone `/model …` submits route silently to that handler instead of
 *   the built-in /model command — inherited from ModelCommandRoutingEditor.
 */
class PreviousMessageEditor extends ModelCommandRoutingEditor {
	/** Entries for the current project; index 0 = most recent. */
	private entries: string[] = [];
	/** -1 = not browsing; 0 = most recent entry, 1 = older, … */
	private rollbackIndex = -1;
	/** Editor text captured when rollback mode was entered. */
	private rollbackDraft = "";
	/** Called when the TUI records a submitted message (addToHistory). */
	private onRecord?: (text: string) => void;
	/** App-level manager injected into CustomEditor (whose copy is private). */
	private readonly appKeybindings: KeybindingsManager;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.appKeybindings = keybindings;
	}

	attach(
		entries: string[],
		onRecord: (text: string) => void,
		modelCommandHandler?: ModelCommandHandler,
	): void {
		this.entries = entries;
		this.onRecord = onRecord;
		this.modelCommandHandler = modelCommandHandler;
		this.rollbackIndex = -1;
		this.rollbackDraft = "";
	}

	/** Overridden: every editor-based submission flows through here. */
	addToHistory(text: string): void {
		this.onRecord?.(text);
	}

	/**
	 * Overridden: any programmatic text replacement (submit-clear, queued
	 * message restore, external editor, …) ends rollback mode, mirroring the
	 * built-in editor's exit-on-setText behavior.
	 */
	setText(text: string): void {
		this.exitRollback();
		super.setText(text);
	}

	handleInput(data: string): void {
		// ↑ — enter or continue rollback mode. Only a blank editor enters it;
		// once inside, ↑ always walks back regardless of cursor position.
		if (this.appKeybindings.matches(data, "tui.editor.cursorUp")) {
			if (this.isBlank() || this.rollbackIndex >= 0) {
				this.navigateRollback(-1);
				return;
			}
			super.handleInput(data);
			return;
		}
		// ↓ — walk forward while in rollback mode.
		if (this.appKeybindings.matches(data, "tui.editor.cursorDown")) {
			if (this.rollbackIndex >= 0) {
				this.navigateRollback(1);
				return;
			}
			super.handleInput(data);
			return;
		}
		// Dedicated history bindings (bindable via keybindings.json).
		if (this.appKeybindings.matches(data, "tui.editor.historyPrevious")) {
			this.navigateRollback(-1);
			return;
		}
		if (this.appKeybindings.matches(data, "tui.editor.historyNext")) {
			this.navigateRollback(1);
			return;
		}
		// Ctrl+C (app.clear): remember the text before the built-in clears it.
		// Clearing ends rollback mode, so a later ↑ starts browsing fresh.
		if (this.appKeybindings.matches(data, "app.clear")) {
			this.exitRollback();
			const text = this.getText();
			if (text.trim().length > 0) {
				this.onRecord?.(text);
			}
			super.handleInput(data);
			return;
		}
		// Any other key — editing, cursor movement, submit, escape — ends
		// rollback mode and then acts normally. /model routing runs in the
		// base before the built-in submit; the rollback exit here is a no-op
		// for plain submissions.
		this.exitRollback();
		super.handleInput(data);
	}

	private isBlank(): boolean {
		return this.getText().trim().length === 0;
	}

	/** direction: -1 = older (↑), 1 = newer (↓). Mirrors the built-in index math. */
	private navigateRollback(direction: -1 | 1): void {
		if (this.entries.length === 0) return;
		const next = this.rollbackIndex - direction;
		if (next < -1 || next >= this.entries.length) return;
		if (this.rollbackIndex === -1 && next >= 0) {
			this.rollbackDraft = this.getText();
		}
		this.rollbackIndex = next;
		if (this.rollbackIndex === -1) {
			const draft = this.rollbackDraft;
			this.rollbackDraft = "";
			super.setText(draft);
		} else {
			super.setText(this.entries[this.rollbackIndex] ?? "");
		}
	}

	private exitRollback(): void {
		this.rollbackIndex = -1;
		this.rollbackDraft = "";
	}
}

export default function (pi: ExtensionAPI) {
	let currentCwd = "";

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCwd = ctx.cwd;

		// Pick up entries written by other pi instances since we last loaded.
		store.load();

		// The editor-slot module owns the slot: it mounts this contributor
		// unless a higher-priority contributor wins the wave, and re-flushes
		// when the set of contributors changes (e.g. a Profile transition
		// disposing ui-model-selector).
		installSessionEditor(ctx, {
			id: "ui-message-history",
			priority: 20,
			createEditor: (tui, theme, keybindings) => {
				const editor = new PreviousMessageEditor(tui, theme, keybindings);
				editor.attach(
					store.listFor(currentCwd),
					(text) => store.record(currentCwd, text),
					getModelCommandHandler(),
				);
				return editor;
			},
		});
	});

	// Persist any debounced writes before exiting.
	pi.on("session_shutdown", () => store.flush());
}
