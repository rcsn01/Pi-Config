import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { collectSessionUsage, normalizeContextUsage } from "../_shared/usage.ts";
import { isRecord, writeSettingsDocument } from "../_shared/settings-document.ts";

const STATUS_ORDER = ["profile", "approval-mode", "plan"];
const KEYBINDINGS_FILENAME = "keybindings.json";
const THINKING_CYCLE_KEY = "app.thinking.cycle";

type JsonObject = Record<string, unknown>;

function isFileNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function warnKeybindings(message: string, configPath: string, error?: unknown): void {
	const detail = error instanceof Error ? `: ${error.message}` : "";
	console.warn(`[ui-status-separators] ${message} (${configPath})${detail}`);
}

export function ensureThinkingCycleBinding(
	configPath = path.join(getAgentDir(), KEYBINDINGS_FILENAME),
): void {
	let config: JsonObject;

	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!isRecord(parsed)) {
			warnKeybindings("Keybindings config must contain a JSON object; leaving it unchanged", configPath);
			return;
		}
		config = parsed;
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			warnKeybindings("Could not read keybindings config; leaving it unchanged", configPath, error);
			return;
		}
		config = {};
	}

	const thinkingCycleBinding = config[THINKING_CYCLE_KEY];
	if (Array.isArray(thinkingCycleBinding) && thinkingCycleBinding.length === 0) return;

	config[THINKING_CYCLE_KEY] = [];

	try {
		writeSettingsDocument(configPath, config);
	} catch (error) {
		warnKeybindings("Could not update keybindings config", configPath, error);
	}
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatExtensionStatusLine(
	statuses: ReadonlyMap<string, string>,
	width: number,
	ellipsis: string,
): string {
	const targetWidth = Math.max(0, width);
	if (targetWidth === 0) return "";

	const entries = Array.from(statuses.entries())
		.sort(([left], [right]) => {
			const leftOrder = STATUS_ORDER.indexOf(left);
			const rightOrder = STATUS_ORDER.indexOf(right);
			return (leftOrder < 0 ? STATUS_ORDER.length : leftOrder) - (rightOrder < 0 ? STATUS_ORDER.length : rightOrder)
				|| left.localeCompare(right);
		})
		.map(([key, text]) => [key, sanitizeStatusText(text)] as const)
		.filter(([, text]) => Boolean(text));
	const advisor = entries.find(([key]) => key === "advisor")?.[1];
	const leftStatuses = entries.filter(([key]) => key !== "advisor").map(([, text]) => text);
	const left = leftStatuses.join(" | ");

	if (!advisor) return truncateToWidth(left, targetWidth, ellipsis);

	const advisorText = truncateToWidth(advisor, targetWidth, ellipsis);
	const advisorWidth = visibleWidth(advisorText);
	if (advisorWidth >= targetWidth) return advisorText;
	if (!left) return " ".repeat(targetWidth - advisorWidth) + advisorText;

	const leftText = truncateToWidth(left, Math.max(0, targetWidth - advisorWidth - 1), ellipsis);
	const gap = Math.max(1, targetWidth - visibleWidth(leftText) - advisorWidth);
	return `${leftText}${" ".repeat(gap)}${advisorText}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	const relativeToHome = path.relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${path.sep}${relativeToHome}`;
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => ({
		dispose: footerData.onBranchChange(() => tui.requestRender()),
		invalidate() {},
		render(width: number): string[] {
			const usage = collectSessionUsage(ctx.sessionManager.getEntries());

			let pwd = formatCwd(ctx.sessionManager.getCwd());
			const branch = footerData.getGitBranch();
			if (branch) pwd = `${pwd} (${branch})`;

			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) pwd = `${pwd} • ${sessionName}`;

			const statsParts: string[] = [];
			if (usage.input) statsParts.push(`↑${formatTokens(usage.input)}`);
			if (usage.output) statsParts.push(`↓${formatTokens(usage.output)}`);
			if (usage.cacheRead) statsParts.push(`R${formatTokens(usage.cacheRead)}`);
			if (usage.cacheWrite) statsParts.push(`W${formatTokens(usage.cacheWrite)}`);
			if (usage.cost) statsParts.push(`$${usage.cost.toFixed(3)}`);

			const contextUsage = normalizeContextUsage(ctx.getContextUsage(), ctx.model?.contextWindow);
			const contextPercentValue = contextUsage.percent ?? 0;
			const contextPercent = contextUsage.percent !== null
				? contextPercentValue.toFixed(1)
				: "?";
			const contextDisplay = contextPercent === "?"
				? `?/${formatTokens(contextUsage.contextWindow)} (auto)`
				: `${contextPercent}%/${formatTokens(contextUsage.contextWindow)} (auto)`;
			statsParts.push(
				contextPercentValue > 90
					? theme.fg("error", contextDisplay)
					: contextPercentValue > 70
						? theme.fg("warning", contextDisplay)
						: contextDisplay,
			);

			let statsLeft = statsParts.join(" ");
			let statsLeftWidth = visibleWidth(statsLeft);
			if (statsLeftWidth > width) {
				statsLeft = truncateToWidth(statsLeft, width, "...");
				statsLeftWidth = visibleWidth(statsLeft);
			}

			const modelName = ctx.model?.id || "no-model";
			let rightSide = modelName;
			if (ctx.model?.reasoning) {
				const thinkingLevel = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "off";
				rightSide = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
			}
			if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
				const withProvider = `(${ctx.model.provider}) ${rightSide}`;
				if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
					rightSide = withProvider;
				}
			}

			const rightSideWidth = visibleWidth(rightSide);
			const totalNeeded = statsLeftWidth + 2 + rightSideWidth;
			let statsLine: string;
			if (totalNeeded <= width) {
				statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
			} else {
				const availableForRight = width - statsLeftWidth - 2;
				if (availableForRight > 0) {
					const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
					statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) + truncatedRight;
				} else {
					statsLine = statsLeft;
				}
			}

			const lines = [
				truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
				theme.fg("dim", statsLine),
			];

			const extensionStatuses = footerData.getExtensionStatuses();
			if (extensionStatuses.size > 0) {
				const statusLine = formatExtensionStatusLine(
					extensionStatuses,
					width,
					theme.fg("dim", "..."),
				);
				if (statusLine) lines.push(statusLine);
			}

			return lines;
		},
	}));
}

export default function (pi: ExtensionAPI) {
	ensureThinkingCycleBinding();
	pi.on("session_start", async (_event, ctx) => installFooter(pi, ctx));
	pi.on("session_tree", async (_event, ctx) => installFooter(pi, ctx));
}
