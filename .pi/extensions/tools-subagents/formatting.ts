import { visibleWidth } from "@earendil-works/pi-tui";

export function formatTokens(value: number): string {
	return value < 1000 ? String(value) : value < 10000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value / 1000)}k`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export function formatToolArgsPreview(args: Record<string, unknown>): string {
	if (Array.isArray(args.operations)) return `repo_query: ${args.operations.length} operations`;
	if (args.command) return String(args.command).slice(0, 100);
	if (args.path) return String(args.path);
	if (args.query) return `"${String(args.query).slice(0, 80)}"`;
	if (args.url) return String(args.url);
	if (args.pattern) return String(args.pattern);
	const serialized = JSON.stringify(args);
	return serialized.length > 80 ? `${serialized.slice(0, 80)}…` : serialized;
}

export function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2)}M context`;
	}
	if (tokens >= 1_000) {
		const thousands = tokens / 1_000;
		return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K context`;
	}
	return `${tokens} context`;
}

export function truncateDisplayLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	let result = "";
	let width = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === "\x1b") {
			const match = text.slice(index).match(/^\x1b\[[0-9;]*m/);
			if (match) {
				result += match[0];
				index += match[0].length - 1;
				continue;
			}
		}
		if (width >= maxWidth - 1) return `${result}…`;
		result += character;
		width++;
	}
	return result;
}
