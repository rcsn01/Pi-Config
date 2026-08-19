import { describe, expect, it, vi } from "vitest";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { installOverlayInputGuard } from "./overlay-input-guard.ts";

type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

function fakeComponent(): Component {
	return { render: () => [], invalidate: () => {} };
}

function fakeHandle(initialFocused = false): {
	handle: OverlayHandle;
	focusCount: () => number;
	isFocused: () => boolean;
} {
	let focused = initialFocused;
	let count = 0;
	return {
		handle: {
			hide: () => {},
			setHidden: () => {},
			isHidden: () => false,
			focus: () => {
				focused = true;
				count += 1;
			},
			unfocus: () => {},
			isFocused: () => focused,
		},
		focusCount: () => count,
		isFocused: () => focused,
	};
}

function fakeTui(topmost: Component | undefined): TUI {
	return {
		getTopmostVisibleOverlay: topmost ? () => ({ component: topmost }) : undefined,
	} as unknown as TUI;
}

function captureListener() {
	let handler: InputHandler | undefined;
	const unsubscribe = vi.fn();
	const registerInputListener = vi.fn((h: InputHandler) => {
		handler = h;
		return unsubscribe;
	});
	return { registerInputListener, handler: () => handler!, unsubscribe };
}

describe("installOverlayInputGuard", () => {
	it("re-focuses the overlay when it is the topmost UI and unfocused", () => {
		const own = fakeComponent();
		const { handle, focusCount, isFocused } = fakeHandle(false);
		const { registerInputListener, handler } = captureListener();
		installOverlayInputGuard({ registerInputListener, tui: fakeTui(own), component: own, handle });

		const result = handler()("q");

		expect(result).toBeUndefined();
		expect(focusCount()).toBe(1);
		expect(isFocused()).toBe(true);
	});

	it("does nothing when the overlay is already focused", () => {
		const own = fakeComponent();
		const { handle, focusCount } = fakeHandle(true);
		const { registerInputListener, handler } = captureListener();
		installOverlayInputGuard({ registerInputListener, tui: fakeTui(own), component: own, handle });

		handler()("q");

		expect(focusCount()).toBe(0);
	});

	it("does not steal input from an overlay on top", () => {
		const own = fakeComponent();
		const other = fakeComponent();
		const { handle, focusCount } = fakeHandle(false);
		const { registerInputListener, handler } = captureListener();
		installOverlayInputGuard({ registerInputListener, tui: fakeTui(other), component: own, handle });

		handler()("q");

		expect(focusCount()).toBe(0);
	});

	it("falls back to re-focusing when the topmost API is unavailable", () => {
		const own = fakeComponent();
		const { handle, focusCount } = fakeHandle(false);
		const { registerInputListener, handler } = captureListener();
		installOverlayInputGuard({ registerInputListener, tui: fakeTui(undefined), component: own, handle });

		handler()("q");

		expect(focusCount()).toBe(1);
	});

	it("returns an unsubscribe that stops the listener", () => {
		const own = fakeComponent();
		const { handle } = fakeHandle(false);
		const { registerInputListener, unsubscribe } = captureListener();
		const stop = installOverlayInputGuard({ registerInputListener, tui: fakeTui(own), component: own, handle });

		stop();

		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});
