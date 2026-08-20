import type { Theme } from "@earendil-works/pi-coding-agent";

export type ThemeVariant = "dark" | "light";

/**
 * Theme spy for visual regression tests.
 *
 * Every token call returns a `token(variant:text)` marker string instead of a
 * color sequence, so tests can assert which semantic tokens a renderer uses
 * and prove renderers emit no hardcoded ANSI escapes (`\x1b[...]`).
 */
export function makeThemeSpy(variant: ThemeVariant = "dark") {
	const tag = variant === "dark" ? "d" : "l";
	const mark = (kind: string) => (text: string) => `${kind}${tag}(${text})`;
	return {
		variant,
		fg: (token: string, text: string) => `${token}${tag}(${text})`,
		bg: (token: string, text: string) => `bg${tag}(${token}:${text})`,
		bold: mark("bold"),
		italic: mark("italic"),
		strikethrough: mark("strike"),
		underline: mark("under"),
	} as unknown as Theme;
}

/**
 * Strip pi-tui's standard `\x1b[0m` reset so tests can assert a renderer
 * emitted no color/style escapes of its own. truncateToWidth appends the
 * reset even to plain text, so the invariant is: no escapes besides resets.
 */
export function stripResets(output: string): string {
	return output.replace(/\x1b\[0m/g, "");
}
