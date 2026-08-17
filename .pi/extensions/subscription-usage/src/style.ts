// ANSI styling applied at the notify boundary (index.ts) — the render
// functions stay plain-text so tool content and unit tests are untouched.
// pi's TUI renderer is SGR-aware: it preserves escape codes, applies a full
// reset at the end of each rendered line, and measures styled text width
// correctly (see pi's tui.md). Applied rules:
// - header lines (ChatGPT Codex / Ollama Cloud): bold bright white
// - the usage bar `[████░░░░]`: bold bright white
// - the "N% used" share: bold
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BRIGHT_WHITE = "\x1b[97m";

const BAR = /\[[█░]+\]/g;
const HEADER = /^(ChatGPT Codex|Ollama Cloud)/;
const PERCENT = /(\d+(?:\.\d+)?% used)/g;

export function styleUsageText(text: string): string {
	return text.split("\n").map(styleLine).join("\n");
}

function styleLine(line: string): string {
	let styled = line;
	styled = styled.replace(BAR, (bar) => `${BRIGHT_WHITE}${BOLD}${bar}${RESET}`);
	styled = styled.replace(PERCENT, (share) => `${BOLD}${share}${RESET}`);
	if (HEADER.test(styled)) {
		styled = `${BRIGHT_WHITE}${BOLD}${styled}${RESET}`;
	}
	return styled;
}

/** Removes SGR escape sequences (for tests and plain-text consumers). */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
