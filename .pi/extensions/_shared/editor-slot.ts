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
 * - Session slot lifetimes: each adapter installs one registration that may
 *   contain an Editor, a model-command handler, an input handler, or a valid
 *   combination for a `SessionStartEvent` token. The module owns automatic
 *   shutdown cleanup, exact-owner disposal, raw-field reload compatibility,
 *   and token- and timer-guarded deferred flushing. The highest-priority Editor
 *   contribution wins, with latest registration breaking ties, and the mounted
 *   editor receives the thinking border.
 * - Input interception: one optional `EditorInputHandler` lives in the same
 *   shared registry. `ModelCommandRoutingEditor`
 *   consults it on every keypress, before /model routing and the built-in
 *   editor handling; returning `true` consumes the key. ui-steer-input uses
 *   this to intercept Tab while the agent streams, except when Tab would
 *   trigger editor completion (open autocomplete popup or an uncompleted
 *   slash token); the mounted editor is never swapped. Note the dispatch
 *   boundary: a subclass (e.g.
 *   PreviousMessageEditor) consumes some keys itself (Up, Down, dedicated
 *   history bindings, Ctrl+C) before delegating to this base class, so the
 *   hook only sees inputs the subclass delegates; it is not a universal
 *   preprocessor.
 *
 * The only remaining external editor swap is the synchronous Plan Review
 * command bridge: it installs and restores the slot around a single
 * synchronous submit call, so terminal input cannot reach the bridge editor.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { reapplyThinkingBorder } from "./editor-border.ts";

export type EditorFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: ConstructorParameters<typeof CustomEditor>[2],
) => EditorComponent;

export type ModelCommandHandler = (args: string) => Promise<void>;

/**
 * Input handler consulted by ModelCommandRoutingEditor before its own
 * routing and the built-in editor handling. Return `true` to consume the
 * key; `false` delegates. Receives the raw terminal data and the editor
 * instance the keypress reached.
 */
export type EditorInputHandler = (data: string, editor: EditorComponent) => boolean;

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
	/** Stable registration id; re-registering replaces the same id. */
	id: string;
	editor?: {
		/** Higher priority wins the flush. */
		priority: number;
		createEditor: EditorFactory;
	};
	modelCommandHandler?: ModelCommandHandler;
	editorInputHandler?: EditorInputHandler;
}

export interface SessionEditorLifetime {
	install(
		event: SessionStartEvent,
		ctx: ExtensionContext,
		contribution: SessionEditorContribution,
	): void;
	dispose(): void;
}

interface ContributionEntry {
	contribution: {
		id: string;
		priority: number;
		createEditor: EditorFactory;
	};
	ctx: ExtensionContext;
	sessionToken: SessionStartEvent;
	/** Monotonic registration order; ties in priority break by latest. */
	order: number;
}

interface HandlerEntry<T> {
	registrationId: string;
	handler: T;
	sessionToken: SessionStartEvent;
}

interface EditorSlotRegistry {
	modelCommandHandler?: ModelCommandHandler;
	modelCommandHandlerEntry?: HandlerEntry<ModelCommandHandler>;
	editorInputHandler?: EditorInputHandler;
	editorInputHandlerEntry?: HandlerEntry<EditorInputHandler>;
	contributions: Map<string, ContributionEntry>;
	nextOrder: number;
	flushTimer?: ReturnType<typeof setTimeout>;
	activeSessionToken?: SessionStartEvent;
}

function getRegistry(): EditorSlotRegistry {
	const globalRegistry = globalThis as typeof globalThis & { [REGISTRY_KEY]?: EditorSlotRegistry };
	const registry = globalRegistry[REGISTRY_KEY] ??= { contributions: new Map(), nextOrder: 0 };
	if (!(registry.contributions instanceof Map)) registry.contributions = new Map();
	if (typeof registry.nextOrder !== "number") registry.nextOrder = 0;
	return registry;
}

export function getModelCommandHandler(): ModelCommandHandler | undefined {
	return getRegistry().modelCommandHandler;
}

export function getEditorInputHandler(): EditorInputHandler | undefined {
	return getRegistry().editorInputHandler;
}

// -------------------------------------------------------- wave coordination ---

function pickWinner(
	registry: EditorSlotRegistry,
	sessionToken: SessionStartEvent,
): ContributionEntry | undefined {
	let winner: ContributionEntry | undefined;
	for (const entry of registry.contributions.values()) {
		if (entry.sessionToken !== sessionToken) continue;
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

function flushSessionEditor(sessionToken: SessionStartEvent): void {
	const registry = getRegistry();
	if (registry.activeSessionToken !== sessionToken) return;
	const winner = pickWinner(registry, sessionToken);
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
		// setEditorComponent constructs the factory synchronously. Preserve the
		// existing best-effort behavior for a torn-down TUI or invalid factory.
	}
}

function cancelFlush(registry: EditorSlotRegistry): void {
	if (registry.flushTimer === undefined) return;
	clearTimeout(registry.flushTimer);
	registry.flushTimer = undefined;
}

function scheduleFlush(sessionToken: SessionStartEvent): void {
	const registry = getRegistry();
	if (registry.flushTimer !== undefined) return;
	const timer = setTimeout(() => {
		if (registry.flushTimer !== timer || registry.activeSessionToken !== sessionToken) return;
		registry.flushTimer = undefined;
		flushSessionEditor(sessionToken);
	}, 0);
	registry.flushTimer = timer;
}

function establishSessionWave(sessionToken: SessionStartEvent): EditorSlotRegistry {
	const registry = getRegistry();
	if (registry.activeSessionToken === sessionToken) return registry;
	cancelFlush(registry);
	registry.contributions.clear();
	registry.modelCommandHandler = undefined;
	registry.modelCommandHandlerEntry = undefined;
	registry.editorInputHandler = undefined;
	registry.editorInputHandlerEntry = undefined;
	registry.activeSessionToken = sessionToken;
	return registry;
}

interface OwnedRegistration {
	id: string;
	sessionToken: SessionStartEvent;
	editor?: ContributionEntry;
	modelCommandHandler?: HandlerEntry<ModelCommandHandler>;
	editorInputHandler?: HandlerEntry<EditorInputHandler>;
}

function detachModelHandler(entry: HandlerEntry<ModelCommandHandler>): void {
	const registry = getRegistry();
	if (registry.modelCommandHandlerEntry !== entry) return;
	registry.modelCommandHandlerEntry = undefined;
	if (registry.modelCommandHandler === entry.handler) registry.modelCommandHandler = undefined;
}

function detachEditorInputHandler(entry: HandlerEntry<EditorInputHandler>): void {
	const registry = getRegistry();
	if (registry.editorInputHandlerEntry !== entry) return;
	registry.editorInputHandlerEntry = undefined;
	if (registry.editorInputHandler === entry.handler) registry.editorInputHandler = undefined;
}

function detachHandlerForId(id: string): void {
	const registry = getRegistry();
	if (registry.modelCommandHandlerEntry?.registrationId === id) {
		detachModelHandler(registry.modelCommandHandlerEntry);
	}
	if (registry.editorInputHandlerEntry?.registrationId === id) {
		detachEditorInputHandler(registry.editorInputHandlerEntry);
	}
}

function detachEditorContribution(entry: ContributionEntry): boolean {
	const registry = getRegistry();
	if (registry.contributions.get(entry.contribution.id) !== entry) return false;
	registry.contributions.delete(entry.contribution.id);
	return true;
}

function removeForReplacement(
	previous: OwnedRegistration | undefined,
	id: string,
): ContributionEntry[] {
	const removedEditors: ContributionEntry[] = [];
	if (previous?.modelCommandHandler) detachModelHandler(previous.modelCommandHandler);
	if (previous?.editorInputHandler) detachEditorInputHandler(previous.editorInputHandler);
	if (previous?.editor && detachEditorContribution(previous.editor)) {
		removedEditors.push(previous.editor);
	}

	const registry = getRegistry();
	const sameId = registry.contributions.get(id);
	if (sameId && detachEditorContribution(sameId)) removedEditors.push(sameId);
	detachHandlerForId(id);
	return removedEditors;
}

function restoreBuiltInEditor(ctx: ExtensionContext): void {
	try {
		ctx.ui.setEditorComponent(undefined);
	} catch {
		// Pi may have torn down the TUI before Session cleanup runs.
	}
}

function reconcileEditorRemoval(entry: ContributionEntry): void {
	const registry = getRegistry();
	if (registry.activeSessionToken !== entry.sessionToken) return;
	if (pickWinner(registry, entry.sessionToken)) {
		scheduleFlush(entry.sessionToken);
		return;
	}
	cancelFlush(registry);
	restoreBuiltInEditor(entry.ctx);
}

function disposeOwnedRegistration(owned: OwnedRegistration): void {
	if (owned.modelCommandHandler) detachModelHandler(owned.modelCommandHandler);
	if (owned.editorInputHandler) detachEditorInputHandler(owned.editorInputHandler);
	if (!owned.editor) return;

	const removed = detachEditorContribution(owned.editor);
	const registry = getRegistry();
	if (!removed || registry.activeSessionToken !== owned.editor.sessionToken) return;
	reconcileEditorRemoval(owned.editor);
}

/** Own one adapter's Session editor, model-handler, and input-handler registration. */
export function createSessionEditorLifetime(
	pi: Pick<ExtensionAPI, "on">,
): SessionEditorLifetime {
	let current: OwnedRegistration | undefined;

	const dispose = (): void => {
		const owned = current;
		current = undefined;
		if (owned) disposeOwnedRegistration(owned);
	};

	pi.on("session_shutdown", dispose);
	return {
		install(event, ctx, contribution) {
			if (!contribution.editor && !contribution.modelCommandHandler && !contribution.editorInputHandler) {
				throw new TypeError("SessionEditorLifetime.install() requires an Editor or handler contribution");
			}
			const previous = current;
			current = undefined;
			const registry = establishSessionWave(event);
			const removedEditors = removeForReplacement(previous, contribution.id);
			const editor = contribution.editor
				? {
					contribution: {
						id: contribution.id,
						priority: contribution.editor.priority,
						createEditor: contribution.editor.createEditor,
					},
					ctx,
					sessionToken: event,
					order: registry.nextOrder++,
				}
				: undefined;
			const modelCommandHandler = contribution.modelCommandHandler
				? {
					registrationId: contribution.id,
					handler: contribution.modelCommandHandler,
					sessionToken: event,
				}
				: undefined;
			const editorInputHandler = contribution.editorInputHandler
				? {
					registrationId: contribution.id,
					handler: contribution.editorInputHandler,
					sessionToken: event,
				}
				: undefined;

			if (editor) registry.contributions.set(contribution.id, editor);
			if (modelCommandHandler) {
				registry.modelCommandHandler = modelCommandHandler.handler;
				registry.modelCommandHandlerEntry = modelCommandHandler;
			}
			if (editorInputHandler) {
				registry.editorInputHandler = editorInputHandler.handler;
				registry.editorInputHandlerEntry = editorInputHandler;
			}
			current = {
				id: contribution.id,
				sessionToken: event,
				editor,
				modelCommandHandler,
				editorInputHandler,
			};

			if (editor) {
				scheduleFlush(event);
			} else {
				const activeRemoved = removedEditors.find((entry) =>
					entry.sessionToken === event && registry.activeSessionToken === event);
				if (activeRemoved) reconcileEditorRemoval(activeRemoved);
			}
		},
		dispose,
	};
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
		// Consult the shared input handler on every keypress: session editor
		// construction and handler registration can happen in either order
		// during the deferred session_start wave, so no construction-time
		// snapshot can stand in for the registry.
		if (getEditorInputHandler()?.(data, this)) return;
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