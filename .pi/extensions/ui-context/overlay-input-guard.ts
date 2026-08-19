import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

export interface OverlayInputGuardDeps {
	/** Register a raw terminal input listener; returns an unsubscribe function. */
	registerInputListener: (handler: InputHandler) => () => void;
	/** The TUI instance the overlay was opened on. */
	tui: TUI;
	/** The overlay component to keep focused. */
	component: Component;
	/** The overlay handle returned by pi for this overlay. */
	handle: OverlayHandle;
}

/**
 * Keep keyboard input routed to a capturing overlay while it is the topmost
 * visible UI.
 *
 * Pi's TUI runs `onTerminalInput` listeners before its overlay focus-restore
 * logic and before the focused component receives the keystroke, so re-focusing
 * here routes the keystroke to the overlay even when an independent non-overlay
 * UI (e.g. plan mode's review menu) stole focus from it. Without this, pi's
 * "blocked" focus-restore state keeps input with the focus thief while the
 * overlay stays visually on top.
 *
 * The topmost check uses `Tui.getTopmostVisibleOverlay()`, which is
 * TypeScript-private but present at runtime. If it is ever removed, the guard
 * falls back to assuming this overlay is topmost.
 */
export function installOverlayInputGuard(deps: OverlayInputGuardDeps): () => void {
	const { registerInputListener, tui, component, handle } = deps;
	const getTopmost = (tui as unknown as {
		getTopmostVisibleOverlay?: () => { component: Component } | undefined;
	}).getTopmostVisibleOverlay;
	return registerInputListener(() => {
		const topmost = getTopmost?.();
		const isTopmost = topmost ? topmost.component === component : true;
		if (isTopmost && !handle.isFocused()) handle.focus();
		return undefined;
	});
}
