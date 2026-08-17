import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	invocationTotals,
	tokenCreditsByModel,
	totalWorkspaceUsage,
	usageByClient,
	usageByModel,
	usageBySurface,
	type CodexAnalyticsSnapshot,
	type UsageMetrics,
} from "./analytics.ts";

function number(value: number): string {
	return Number.isInteger(value)
		? value.toLocaleString("en-US")
		: value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function percent(value: number | undefined): string {
	return value === undefined ? "unknown" : `${number(value)}% used`;
}

function metricSummary(metrics: UsageMetrics): string {
	return [
		`${number(metrics.turns)} turns`,
		`${number(metrics.threads)} threads`,
		`${number(metrics.credits)} credits`,
		`${number(metrics.totalTokens)} tokens`,
	].join(" · ");
}

function section(lines: string[], title: string, entries: string[]): void {
	lines.push("", `${title}:`);
	lines.push(...(entries.length ? entries.map((entry) => `  ${entry}`) : ["  None"]));
}

export function formatAnalyticsLines(snapshot: CodexAnalyticsSnapshot): string[] {
	const lines = [
		"ChatGPT Codex Analytics",
		`${snapshot.startDate} to ${snapshot.endDate} · fetched ${snapshot.fetchedAt}`,
	];
	const quota = snapshot.quota;
	section(lines, "Subscription and limits", [
		...(quota.plan ? [`Plan: ${quota.plan}`] : []),
		...quota.rateLimits.flatMap((limit) => [
			`${limit.label}: ${limit.allowed === false ? "blocked" : "available"}${limit.limitReached ? " · limit reached" : ""}`,
			...(limit.primary ? [`${limit.label} primary: ${percent(limit.primary.usedPercent)}${limit.primary.resetAt ? ` · resets ${limit.primary.resetAt}` : ""}`] : []),
			...(limit.secondary ? [`${limit.label} secondary: ${percent(limit.secondary.usedPercent)}${limit.secondary.resetAt ? ` · resets ${limit.secondary.resetAt}` : ""}`] : []),
		]),
		...(quota.credits ? [
			`Credit balance: ${quota.credits.unlimited ? "unlimited" : quota.credits.balance === undefined ? "unknown" : number(quota.credits.balance)}`,
			...(quota.credits.approxCloudMessages.length ? [`Approx. cloud messages: ${quota.credits.approxCloudMessages.map(number).join("–")}`] : []),
			...(quota.credits.approxLocalMessages.length ? [`Approx. local messages: ${quota.credits.approxLocalMessages.map(number).join("–")}`] : []),
		] : []),
		...(quota.rateLimitResetCredits ? [`Rate-limit reset credits: ${number(quota.rateLimitResetCredits.available)} available · ${number(quota.rateLimitResetCredits.applicable)} applicable`] : []),
		...(quota.spendLimitReached === undefined ? [] : [`Spend limit reached: ${quota.spendLimitReached ? "yes" : "no"}`]),
	]);

	const total = totalWorkspaceUsage(snapshot);
	section(lines, "Period totals", [
		`${number(total.users)} users · ${metricSummary(total)}`,
		`Input tokens: ${number(total.uncachedInputTokens)} uncached · ${number(total.cachedInputTokens)} cached`,
		`Output tokens: ${number(total.outputTokens)}`,
	]);
	section(lines, "Models", usageByModel(snapshot).map((item) => `${item.name}: ${metricSummary(item)}`));
	section(lines, `Model credit usage${snapshot.units ? ` (${snapshot.units})` : ""}`,
		tokenCreditsByModel(snapshot).map((item) => `${item.name}${item.speed ? ` · ${item.speed}` : ""}: ${number(item.credits)}`));
	section(lines, "Clients", usageByClient(snapshot).map((item) => `${item.name}: ${metricSummary(item)}`));
	section(lines, `Product surfaces${snapshot.units ? ` (${snapshot.units})` : ""}`,
		usageBySurface(snapshot).map((item) => `${item.name}: ${number(item.credits)}`));
	section(lines, "Skills", invocationTotals(snapshot.dailySkills).map((item) =>
		`${item.displayName ?? item.name}: ${number(item.invocations)} invocations`));
	section(lines, "Plugins", invocationTotals(snapshot.dailyPlugins).map((item) =>
		`${item.displayName ?? item.name}: ${number(item.invocations)} invocations`));
	section(lines, "Daily workspace usage", snapshot.dailyWorkspace.map((day) => `${day.date}: ${metricSummary(day.totals)}`));
	section(lines, "Credit events", snapshot.creditEvents.map((event) =>
		`${event.date ?? "Unknown date"}: ${event.type ?? "credit event"}${event.credits === undefined ? "" : ` · ${number(event.credits)} credits`}`));
	lines.push("", "Press Escape or Enter to close");
	return lines;
}

export function formatAnalyticsText(snapshot: CodexAnalyticsSnapshot): string {
	return formatAnalyticsLines(snapshot).filter((line) => !line.startsWith("Press Escape")).join("\n").trimEnd();
}

export class AnalyticsComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly snapshot: CodexAnalyticsSnapshot,
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || data === "q") {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const plain = formatAnalyticsLines(this.snapshot);
		this.cachedLines = plain.map((line, index) => {
			let styled = line;
			if (index === 0) styled = this.theme.fg("accent", this.theme.bold(line));
			else if (line.endsWith(":")) styled = this.theme.fg("accent", line);
			else if (line.startsWith("Press ")) styled = this.theme.fg("dim", line);
			return truncateToWidth(styled, Math.max(1, width));
		});
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
