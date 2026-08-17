import type { AnalyticsProbeResult } from "./types.ts";

export interface RateLimitWindow {
	usedPercent?: number;
	windowSeconds?: number;
	resetAt?: string;
}

export interface RateLimit {
	label: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: RateLimitWindow;
	secondary?: RateLimitWindow;
}

export interface QuotaSummary {
	plan?: string;
	rateLimits: RateLimit[];
	credits?: {
		balance?: number;
		hasCredits?: boolean;
		unlimited?: boolean;
		overageLimitReached?: boolean;
		approxCloudMessages: number[];
		approxLocalMessages: number[];
	};
	spendLimitReached?: boolean;
	rateLimitResetCredits?: { available: number; applicable: number };
}

export interface UsageMetrics {
	users: number;
	threads: number;
	turns: number;
	credits: number;
	uncachedInputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

export interface NamedUsageMetrics extends UsageMetrics {
	name: string;
}

export interface DailyWorkspaceUsage {
	date: string;
	totals: UsageMetrics;
	clients: NamedUsageMetrics[];
	models: NamedUsageMetrics[];
}

export interface DailyTokenUsage {
	date: string;
	surfaces: Record<string, number>;
	models: Array<{ model: string; speed?: string; credits: number }>;
}

export interface DailyInvocationUsage {
	date: string;
	items: Array<{ name: string; displayName?: string; invocations: number }>;
}

export interface CreditUsageEvent {
	date?: string;
	type?: string;
	credits?: number;
}

export interface CodexAnalyticsSnapshot {
	startDate: string;
	endDate: string;
	fetchedAt: string;
	units?: string;
	quota: QuotaSummary;
	dailyWorkspace: DailyWorkspaceUsage[];
	dailyTokens: DailyTokenUsage[];
	dailySkills: DailyInvocationUsage[];
	dailyPlugins: DailyInvocationUsage[];
	creditEvents: CreditUsageEvent[];
	dataFreshness?: { skills?: string; plugins?: string };
}

const EMPTY_METRICS: UsageMetrics = {
	users: 0,
	threads: 0,
	turns: 0,
	credits: 0,
	uncachedInputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
};

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function rows(value: unknown): unknown[] {
	return Array.isArray(record(value)?.data) ? record(value)!.data as unknown[] : [];
}

function finite(value: unknown): number | undefined {
	const parsed = typeof value === "number"
		? value
		: typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function text(value: unknown, maximum = 160): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.trim();
	return result && result.length <= maximum && !/[\u0000-\u001f\u007f]/.test(result) ? result : undefined;
}

function date(value: unknown): string | undefined {
	const result = text(value, 32)?.slice(0, 10);
	return result && /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : undefined;
}

function timestamp(value: unknown): string | undefined {
	const numeric = finite(value);
	if (numeric !== undefined) {
		const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
		const result = new Date(milliseconds);
		return Number.isFinite(result.getTime()) ? result.toISOString() : undefined;
	}
	const result = text(value, 64);
	return result && Number.isFinite(Date.parse(result)) ? new Date(result).toISOString() : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function metric(source: Record<string, unknown>, ...keys: string[]): number {
	for (const key of keys) {
		const value = finite(source[key]);
		if (value !== undefined) return value;
	}
	return 0;
}

function metrics(value: unknown): UsageMetrics {
	const source = record(value) ?? {};
	return {
		users: metric(source, "users", "user_count"),
		threads: metric(source, "threads", "thread_count"),
		turns: metric(source, "turns", "turn_count"),
		credits: metric(source, "credits", "credit_count"),
		uncachedInputTokens: metric(source, "uncached_text_input_tokens", "uncached_input_tokens"),
		cachedInputTokens: metric(source, "cached_text_input_tokens", "cached_input_tokens"),
		outputTokens: metric(source, "text_output_tokens", "output_tokens"),
		totalTokens: metric(source, "text_total_tokens", "total_tokens", "tokens"),
	};
}

function namedMetrics(value: unknown, nameKeys: string[]): NamedUsageMetrics | undefined {
	const source = record(value);
	if (!source) return undefined;
	const name = nameKeys.map((key) => text(source[key])).find(Boolean);
	if (!name) return undefined;
	return { name, ...metrics(source) };
}

function window(value: unknown): RateLimitWindow | undefined {
	const source = record(value);
	if (!source) return undefined;
	const result: RateLimitWindow = {
		usedPercent: finite(source.used_percent),
		windowSeconds: finite(source.limit_window_seconds),
		resetAt: timestamp(source.reset_at),
	};
	return Object.values(result).some((entry) => entry !== undefined) ? result : undefined;
}

function rateLimit(value: unknown, label: string): RateLimit | undefined {
	const source = record(value);
	if (!source) return undefined;
	const result: RateLimit = {
		label,
		allowed: bool(source.allowed),
		limitReached: bool(source.limit_reached),
		primary: window(source.primary_window),
		secondary: window(source.secondary_window),
	};
	return Object.values(result).some((entry) => entry !== undefined) ? result : undefined;
}

function numberList(value: unknown): number[] {
	return Array.isArray(value)
		? value.map(finite).filter((item): item is number => item !== undefined).slice(0, 20)
		: [];
}

function normalizeQuota(value: unknown): QuotaSummary {
	const source = record(value) ?? {};
	const rateLimits: RateLimit[] = [];
	const standard = rateLimit(source.rate_limit, "Codex");
	const review = rateLimit(source.code_review_rate_limit, "Code review");
	if (standard) rateLimits.push(standard);
	if (review) rateLimits.push(review);
	const additional = source.additional_rate_limits;
	const additionalObject = record(additional);
	const additionalRows = Array.isArray(additional)
		? additional
		: additionalObject ? Object.entries(additionalObject).map(([name, entry]) => ({ name, ...(record(entry) ?? {}) })) : [];
	for (const entry of additionalRows) {
		const item = record(entry);
		const normalized = rateLimit(item, text(item?.name) ?? text(item?.label) ?? "Additional");
		if (normalized) rateLimits.push(normalized);
	}
	const credits = record(source.credits);
	const spend = record(source.spend_control);
	const resetCredits = record(source.rate_limit_reset_credits);
	return {
		plan: text(source.plan_type),
		rateLimits,
		credits: credits ? {
			balance: finite(credits.balance),
			hasCredits: bool(credits.has_credits),
			unlimited: bool(credits.unlimited),
			overageLimitReached: bool(credits.overage_limit_reached),
			approxCloudMessages: numberList(credits.approx_cloud_messages),
			approxLocalMessages: numberList(credits.approx_local_messages),
		} : undefined,
		spendLimitReached: bool(spend?.reached),
		rateLimitResetCredits: resetCredits ? {
			available: finite(resetCredits.available_count) ?? 0,
			applicable: finite(resetCredits.applicable_available_count) ?? 0,
		} : undefined,
	};
}

function normalizeWorkspace(value: unknown): DailyWorkspaceUsage[] {
	return rows(value).flatMap((entry) => {
		const source = record(entry);
		const day = date(source?.date);
		if (!source || !day) return [];
		const clients = Array.isArray(source.clients)
			? source.clients.map((item) => namedMetrics(item, ["client_id", "client", "name"])).filter((item): item is NamedUsageMetrics => Boolean(item))
			: [];
		const models = Array.isArray(source.models)
			? source.models.map((item) => namedMetrics(item, ["model", "name"])).filter((item): item is NamedUsageMetrics => Boolean(item))
			: [];
		return [{ date: day, totals: metrics(source.totals), clients, models }];
	}).slice(0, 366);
}

function normalizeTokens(value: unknown): DailyTokenUsage[] {
	return rows(value).flatMap((entry) => {
		const source = record(entry);
		const day = date(source?.date);
		if (!source || !day) return [];
		const surfaces: Record<string, number> = {};
		for (const [name, raw] of Object.entries(record(source.product_surface_usage_values) ?? {})) {
			const amount = finite(raw);
			if (/^[a-z][a-z0-9_-]{0,63}$/i.test(name) && amount !== undefined) surfaces[name] = amount;
		}
		const models = Array.isArray(source.models) ? source.models.flatMap((entry) => {
			const item = record(entry);
			const model = text(item?.model);
			if (!item || !model) return [];
			return [{ model, speed: text(item.speed), credits: finite(item.credits) ?? 0 }];
		}) : [];
		return [{ date: day, surfaces, models }];
	}).slice(0, 366);
}

function invocationCount(value: unknown): number {
	const direct = finite(value);
	if (direct !== undefined) return direct;
	const source = record(value);
	return source ? metric(source, "total", "count", "invocations") : 0;
}

function normalizeInvocations(value: unknown, kind: "skill" | "plugin"): DailyInvocationUsage[] {
	const listKey = `${kind}_usage_overviews`;
	return rows(value).flatMap((entry) => {
		const source = record(entry);
		const day = date(source?.date);
		if (!source || !day) return [];
		const list = Array.isArray(source[listKey]) ? source[listKey] as unknown[] : [];
		const items = list.flatMap((entry) => {
			const item = record(entry);
			const name = text(item?.[`${kind}_name`]) ?? text(item?.display_name);
			if (!item || !name) return [];
			return [{ name, displayName: text(item.display_name), invocations: invocationCount(item.invocation_counts) }];
		});
		return [{ date: day, items }];
	}).slice(0, 366);
}

function normalizeCreditEvents(value: unknown): CreditUsageEvent[] {
	return rows(value).flatMap((entry) => {
		const source = record(entry);
		if (!source) return [];
		const normalized: CreditUsageEvent = {
			date: date(source.date) ?? timestamp(source.timestamp),
			type: text(source.event_type) ?? text(source.type),
			credits: finite(source.credits) ?? finite(source.credit_amount) ?? finite(source.amount),
		};
		return Object.values(normalized).some((item) => item !== undefined) ? [normalized] : [];
	}).slice(0, 2_000);
}

export function normalizeCodexAnalytics(result: AnalyticsProbeResult): CodexAnalyticsSnapshot | undefined {
	if (result.state !== "ok") return undefined;
	const tokenRoot = record(result.payloads.tokens);
	const skillsRoot = record(result.payloads.skills);
	const pluginsRoot = record(result.payloads.plugins);
	return {
		startDate: result.startDate,
		endDate: result.endDate,
		fetchedAt: result.fetchedAt,
		units: text(tokenRoot?.units),
		quota: normalizeQuota(result.payloads.quota),
		dailyWorkspace: normalizeWorkspace(result.payloads.workspace),
		dailyTokens: normalizeTokens(result.payloads.tokens),
		dailySkills: normalizeInvocations(result.payloads.skills, "skill"),
		dailyPlugins: normalizeInvocations(result.payloads.plugins, "plugin"),
		creditEvents: normalizeCreditEvents(result.payloads.credits),
		dataFreshness: {
			skills: timestamp(skillsRoot?.data_freshness_ts),
			plugins: timestamp(pluginsRoot?.data_freshness_ts),
		},
	};
}

export function addMetrics(target: UsageMetrics, source: UsageMetrics): UsageMetrics {
	for (const key of Object.keys(EMPTY_METRICS) as Array<keyof UsageMetrics>) target[key] += source[key];
	return target;
}

export function totalWorkspaceUsage(snapshot: CodexAnalyticsSnapshot): UsageMetrics {
	return snapshot.dailyWorkspace.reduce((total, day) => addMetrics(total, day.totals), { ...EMPTY_METRICS });
}

function aggregateNamed(rows: NamedUsageMetrics[][]): NamedUsageMetrics[] {
	const totals = new Map<string, UsageMetrics>();
	for (const row of rows.flat()) {
		const current = totals.get(row.name) ?? { ...EMPTY_METRICS };
		totals.set(row.name, addMetrics(current, row));
	}
	return [...totals].map(([name, values]) => ({ name, ...values })).sort((a, b) => b.credits - a.credits || b.turns - a.turns || a.name.localeCompare(b.name));
}

export function usageByModel(snapshot: CodexAnalyticsSnapshot): NamedUsageMetrics[] {
	return aggregateNamed(snapshot.dailyWorkspace.map((day) => day.models));
}

export function usageByClient(snapshot: CodexAnalyticsSnapshot): NamedUsageMetrics[] {
	return aggregateNamed(snapshot.dailyWorkspace.map((day) => day.clients));
}

export function tokenCreditsByModel(snapshot: CodexAnalyticsSnapshot): Array<{ name: string; speed?: string; credits: number }> {
	const totals = new Map<string, { name: string; speed?: string; credits: number }>();
	for (const day of snapshot.dailyTokens) {
		for (const item of day.models) {
			const key = `${item.model}\0${item.speed ?? ""}`;
			const current = totals.get(key) ?? { name: item.model, speed: item.speed, credits: 0 };
			current.credits += item.credits;
			totals.set(key, current);
		}
	}
	return [...totals.values()].sort((a, b) => b.credits - a.credits || a.name.localeCompare(b.name));
}

export function usageBySurface(snapshot: CodexAnalyticsSnapshot): Array<{ name: string; credits: number }> {
	const totals = new Map<string, number>();
	for (const day of snapshot.dailyTokens) {
		for (const [name, credits] of Object.entries(day.surfaces)) totals.set(name, (totals.get(name) ?? 0) + credits);
	}
	return [...totals].map(([name, credits]) => ({ name, credits })).sort((a, b) => b.credits - a.credits || a.name.localeCompare(b.name));
}

export function invocationTotals(days: DailyInvocationUsage[]): Array<{ name: string; displayName?: string; invocations: number }> {
	const totals = new Map<string, { displayName?: string; invocations: number }>();
	for (const day of days) {
		for (const item of day.items) {
			const current = totals.get(item.name) ?? { displayName: item.displayName, invocations: 0 };
			current.invocations += item.invocations;
			totals.set(item.name, current);
		}
	}
	return [...totals].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name));
}
