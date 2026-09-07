/**
 * Editor slot module — the owner of Pi's single TUI input editor slot.
 *
 * Pi wires exactly one editor component into its TUI
 * (`ctx.ui.setEditorComponent`). Several extensions want to contribute editor
 * behavior (silent /model routing, rollback history navigation), but the slot
 * has a single occupant. This module is the interface at that seam:
 *
 * - The silent `/model` routing editor base class and its grammar
 *   (`ModelCommandRoutingEditor`, `parseModelCommand`). Extensions subclass it
 *   instead of reimplementing routing; the /model handler reaches every
 *   editor through the shared registry below.
 * - A `/model` handler registry. The extension loader gives each extension
 *   its own copy of shared modules (fresh jiti instance per extension), so
 *   plain module state is per-extension. The registry is keyed on
 *   `Symbol.for` in `globalThis`, which resolves identically across module
 *   copies (the same mechanism `_shared/subagent-service.ts` uses).
 * - Wave-coordinated session editor installation: contributors register
 *   `{id, priority, createEditor}` during the `session_start` wave and one
 *   deferred flush mounts the highest-priority contributor's editor,
 *   reapplying the thinking border. A late registration re-flushes and still
 *   wins by priority — ownership is decided by priority, never by timing.
 *
 * Transient editor swaps (steer during streaming, Plan Review command
 * submission) stay in their adapters: they capture and restore whatever this
 * module installed.
 */

import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { reapplyThinkingBorder } from "./editor-border.ts";

export type EditorFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: ConstructorParameters<typeof CustomEditor>[2],
) => EditorComponent;

export type ModelCommandHandler = (args: string) => Promise<void>;

/** Parse a standalone, single-line /model invocation without rewriting it. */
export function parseModelCommand(text: string): string | undefined {
	const command = text.trim();
	if (command.includes("\n")) return undefined;
	const match = /^\/model(?:\s+(.*))?$/.exec(command);
	return match ? (match[1] ?? "").trim() : undefined;
}

// --------------------------------------------------- shared registry state ---

const REGISTRY_KEY = Symbol.for("pi-config.editor-slot.v1");

export interface SessionEditorContribution {
	/** Stable contributor id ("ui-message-history", "ui-model-selector"); re-registering replaces. */
	id: string;
	/** Higher priority wins the flush. */
	priority: number;
	createEditor: EditorFactory;
}

interface ContributionEntry {
	contribution: SessionEditorContribution;
	ctx: ExtensionContext;
	/** Monotonic registration order; ties in priority break by latest. */
	order: number;
}

interface EditorSlotRegistry {
	modelCommandHandler?: ModelCommandHandler;
	contributions: Map<string, ContributionEntry>;
	nextOrder: number;
	flushTimer?: ReturnType<typeof setTimeout>;
}

function getRegistry(): EditorSlotRegistry {
	const globalRegistry = globalThis as typeof globalThis & { [REGISTRY_KEY]?: EditorSlotRegistry };
	return globalRegistry[REGISTRY_KEY] ??= { contributions: new Map(), nextOrder: 0 };
}

/**
 * Register the /model handler every editor routes to. Ownership-safe: the
 * returned unregister only removes this handler, never a newer replacement.
 */
export function registerModelCommandHandler(handler: ModelCommandHandler): () => void {
	const registry = getRegistry();
	registry.modelCommandHandler = handler;
	return () => {
		if (registry.modelCommandHandler === handler) registry.modelCommandHandler = undefined;
	};
}

export function getModelCommandHandler(): ModelCommandHandler | undefined {
	return getRegistry().modelCommandHandler;
}

// -------------------------------------------------------- wave coordination ---

function pickWinner(registry: EditorSlotRegistry): ContributionEntry | undefined {
	let winner: ContributionEntry | undefined;
	for (const entry of registry.contributions.values()) {
		if (
			!winner ||
			entry.contribution.priority > winner.contribution.priority ||
			(entry.contribution.priority === winner.contribution.priority && entry.order > winner.order)
		) {
			winner = entry;
		}
	}
	return winner;
}

function flushSessionEditor(): void {
	const registry = getRegistry();
	const winner = pickWinner(registry);
	if (!winner) return;
	const { contribution, ctx } = winner;
	try {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// Custom editors always carry a borderColor function (Editor's field);
			// the EditorComponent interface merely types it as optional.
			const editor = contribution.createEditor(tui, theme, keybindings) as EditorComponent & {
				borderColor: (text: string) => string;
			};
			reapplyThinkingBorder(ctx, editor, tui);
			return editor;
		});
	} catch {
		// The TUI may already be torn down (e.g. immediate quit); leave the slot alone.
	}
}

function scheduleFlush(): void {
	const registry = getRegistry();
	if (registry.flushTimer !== undefined) return;
	registry.flushTimer = setTimeout(() => {
		registry.flushTimer = undefined;
		flushSessionEditor();
	}, 0);
}

/**
 * Register this session's editor contributor and coordinate the
 * session_start wave: one deferred flush mounts the highest-priority
 * contributor's editor, reapplying the thinking border. The slot is written
 * exactly once per wave — no caller-owned timing. Re-registering an id
 * replaces its contribution and re-flushes.
 */
export function installSessionEditor(ctx: ExtensionContext, contribution: SessionEditorContribution): void {
	const registry = getRegistry();
	registry.contributions.set(contribution.id, {
		contribution,
		ctx,
		order: registry.nextOrder++,
	});
	scheduleFlush();
}

/**
 * Unregister a contributor; restore Pi's built-in editor when none remain,
 * otherwise re-flush so the remaining winner remounts.
 */
export function removeSessionEditor(ctx: ExtensionContext, id: string): void {
	const registry = getRegistry();
	if (!registry.contributions.delete(id)) return;
	if (registry.contributions.size === 0) {
		ctx.ui.setEditorComponent(undefined);
		return;
	}
	scheduleFlush();
}

// ---------------------------------------------------------- routing editor ---

/**
 * Editor that silently intercepts /model before Pi's built-in command path.
 * `modelCommandHandler` is protected and mutable: subclasses that receive the
 * handler after construction (through an `attach`-style method) assign it
 * directly; a `private readonly` constructor-only field could not.
 */
export class ModelCommandRoutingEditor extends CustomEditor {
	protected modelCommandHandler: ModelCommandHandler | undefined;
	private readonly routingKeybindings: ConstructorParameters<typeof CustomEditor>[2];

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		modelCommandHandler?: ModelCommandHandler,
	) {
		super(tui, theme, keybindings);
		this.routingKeybindings = keybindings;
		this.modelCommandHandler = modelCommandHandler;
	}

	override handleInput(data: string): void {
		if (this.modelCommandHandler && this.routingKeybindings.matches(data, "tui.input.submit")) {
			const args = parseModelCommand(this.getText());
			if (args !== undefined) {
				this.setText("");
				void this.modelCommandHandler(args);
				return;
			}
		}
		super.handleInput(data);
	}
}