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
 * - Editor ownership: the TUI has exactly ONE input editor slot. Other
 *   extensions (notably ui-model-selector) install their own editor on every
 *   session_start, which would clobber ours. We therefore (a) re-install on a
 *   deferred tick so we always end up owning the slot, and (b) probe the
 *   previously installed editor factory for a `modelCommandHandler` (the
 *   ModelCommandRoutingEditor contract from ui-model-selector) and replicate
 *   its silent /model routing, so taking over the slot doesn't regress it.
 *   The probe reads a constructor-injected field, so it does not depend on
 *   shared module state (which is per-extension under the extension loader).
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { reapplyThinkingBorder } from "../_shared/editor-border.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeSettingsDocument } from "../_shared/settings-document.ts";

const MAX_ENTRIES = 200;
const SAVE_DEBOUNCE_MS = 400;

type ModelCommandHandler = (args: string) => Promise<void>;

/**
 * Parse a standalone, single-line /model invocation. Mirrors
 * ui-model-selector's `parseModelCommand` (kept local to stay decoupled from
 * that extension's layout).
 */
function parseModelCommand(text: string): string | undefined {
	const command = text.trim();
	if (command.includes("\n")) return undefined;
	const match = /^\/model(?:\s+(.*))?$/.exec(command);
	return match ? (match[1] ?? "").trim() : undefined;
}

function historyFile(): string {
	return join(homedir(), ".pi", "agent", "previous-message-history.json");
}

/**
 * Persistent per-project history store. Entries are keyed by the working
 * directory they were submitted in, so each project recalls its own history.
 * Writes are debounced and atomic (tmp file + rename), and merged with the
 * file on disk so parallel pi instances in other projects don't clobber each
 * other's entries.
 */
const store = {
	data: {} as Record<string, string[]>,
	saveTimer: undefined as ReturnType<typeof setTimeout> | undefined,

	load(): void {
		try {
			const parsed = JSON.parse(readFileSync(historyFile(), "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				this.data = parsed as Record<string, string[]>;
				return;
			}
		} catch {
			// Missing or unreadable file: start fresh.
		}
		this.data = {};
	},

	listFor(cwd: string): string[] {
		let list = this.data[cwd];
		if (!Array.isArray(list)) {
			list = [];
			this.data[cwd] = list;
		}
		return list;
	},

	/** Record a submitted or Ctrl+C-dismissed message for the given cwd. */
	record(cwd: string, text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		const list = this.listFor(cwd);
		// Consecutive duplicates are skipped; re-submitting an older entry
		// moves it to the top, like a shell history.
		if (list[0] === trimmed) return;
		const existing = list.indexOf(trimmed);
		if (existing > 0) list.splice(existing, 1);
		list.unshift(trimmed);
		if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
		this.scheduleSave();
	},

	scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
	},

	saveNow(): void {
		this.saveTimer = undefined;
		try {
			// Merge with whatever is on disk: another pi instance (e.g. in
			// another project) may have written other entries since we loaded.
			let merged = this.data;
			try {
				const onDisk = JSON.parse(readFileSync(historyFile(), "utf8")) as Record<string, string[]>;
				if (onDisk && typeof onDisk === "object" && !Array.isArray(onDisk)) {
					merged = { ...onDisk, ...this.data };
				}
			} catch {
				// First write or unreadable file — write our data as-is.
			}
			writeSettingsDocument(historyFile(), merged);
		} catch (err) {
			console.error("[previous-message] failed to persist history:", err);
		}
	},

	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
			this.saveNow();
		}
	},
};

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
 * - a `modelCommandHandler` (inherited from ui-model-selector's editor) makes
 *   standalone `/model …` submits route silently to that handler instead of
 *   the built-in /model command.
 */
class PreviousMessageEditor extends CustomEditor {
	/** Entries for the current project; index 0 = most recent. */
	private entries: string[] = [];
	/** -1 = not browsing; 0 = most recent entry, 1 = older, … */
	private rollbackIndex = -1;
	/** Editor text captured when rollback mode was entered. */
	private rollbackDraft = "";
	/** Called when the TUI records a submitted message (addToHistory). */
	private onRecord?: (text: string) => void;
	/** ui-model-selector's model control handler (undefined when absent). */
	private modelCommandHandler?: ModelCommandHandler;
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
		// Silent /model routing (inherited from ui-model-selector's editor).
		if (
			this.modelCommandHandler &&
			this.appKeybindings.matches(data, "tui.input.submit")
		) {
			const args = parseModelCommand(this.getText());
			if (args !== undefined) {
				this.setText("");
				void this.modelCommandHandler(args);
				return;
			}
		}
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
		// rollback mode and then acts normally.
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

type EditorFactoryLike = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
) => unknown;

/**
 * Probe a previously installed editor factory for a model command handler.
 * ui-model-selector's ModelCommandRoutingEditor receives the handler via its
 * constructor; we construct one instance (harmless — it is never mounted) and
 * read the field. Any other editor factory yields undefined.
 */
function probeModelCommandHandler(
	previous: EditorFactoryLike | undefined,
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
): ModelCommandHandler | undefined {
	if (!previous) return undefined;
	try {
		const instance = previous(tui, theme, keybindings) as {
			modelCommandHandler?: ModelCommandHandler;
		};
		return instance.modelCommandHandler;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let currentCwd = "";
	/** Editor factory installed by another extension before our handler ran. */
	let capturedPreviousFactory: EditorFactoryLike | undefined;

	const installEditor = (ctx: ExtensionContext) => {
		const entries = store.listFor(currentCwd);
		// Prefer the factory that was present when our session_start handler
		// started; fall back to whatever is installed now (covers the case
		// where another extension's handler ran after ours).
		const previous =
			capturedPreviousFactory ??
			(ctx.ui.getEditorComponent() as EditorFactoryLike | undefined);
		ctx.ui.setEditorComponent(
			(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
				const editor = new PreviousMessageEditor(tui, theme, keybindings);
				const modelHandler = probeModelCommandHandler(
					previous,
					tui,
					theme,
					keybindings,
				);
				editor.attach(
					entries,
					(text) => store.record(currentCwd, text),
					modelHandler,
				);
				reapplyThinkingBorder(ctx, editor, tui);
				return editor;
			},
		);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCwd = ctx.cwd;

		// Pick up entries written by other pi instances since we last loaded.
		store.load();

		// Capture the editor factory another extension may have installed
		// before our handler ran (extension load order is filesystem order).
		capturedPreviousFactory = ctx.ui.getEditorComponent() as EditorFactoryLike | undefined;

		installEditor(ctx);

		// Other extensions (ui-model-selector) install their own editor in
		// their own session_start handlers, which would clobber ours. Reclaim
		// the slot on a deferred tick, after all session_start handlers have
		// run, so the rollback feature stays active.
		setTimeout(() => {
			try {
				installEditor(ctx);
			} catch {
				// TUI may already be torn down (e.g. immediate quit); ignore.
			}
		}, 0);
	});

	// Persist any debounced writes before exiting.
	pi.on("session_shutdown", () => store.flush());
}
