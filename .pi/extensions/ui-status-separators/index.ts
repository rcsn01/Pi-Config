import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as path from "node:path";

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
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
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					totalInput += entry.message.usage.input;
					totalOutput += entry.message.usage.output;
					totalCacheRead += entry.message.usage.cacheRead;
					totalCacheWrite += entry.message.usage.cacheWrite;
					totalCost += entry.message.usage.cost.total;
				}
			}

			let pwd = formatCwd(ctx.sessionManager.getCwd());
			const branch = footerData.getGitBranch();
			if (branch) pwd = `${pwd} (${branch})`;

			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) pwd = `${pwd} • ${sessionName}`;

			const statsParts: string[] = [];
			if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const contextPercentValue = contextUsage?.percent ?? 0;
			const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
				? contextPercentValue.toFixed(1)
				: "?";
			const contextDisplay = contextPercent === "?"
				? `?/${formatTokens(contextWindow)} (auto)`
				: `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
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
				const statusLine = Array.from(extensionStatuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text))
					.filter(Boolean)
					.join(" | ");
				if (statusLine) {
					lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
				}
			}

			return lines;
		},
	}));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => installFooter(pi, ctx));
	pi.on("session_tree", async (_event, ctx) => installFooter(pi, ctx));
}
