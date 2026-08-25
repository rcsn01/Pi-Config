/** Keep the notification boundary plain text across Pi run modes. */
export function styleUsageText(text: string): string {
	return text;
}

/** Removes SGR escape sequences from legacy or externally supplied text. */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
