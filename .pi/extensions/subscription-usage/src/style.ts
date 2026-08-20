/**
 * Keep the notification boundary plain text. Theme-aware styling belongs to
 * the TUI tool renderer, where the active Pi theme is available.
 */
export function styleUsageText(text: string): string {
	return text;
}

/** Removes SGR escape sequences from legacy or externally supplied text. */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
