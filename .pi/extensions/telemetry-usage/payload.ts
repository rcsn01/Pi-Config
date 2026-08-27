import type {
	GlobalModeModelRows,
	GlobalModeTotals,
	GlobalSessionSummary,
	GlobalToolRow,
	GlobalUsageSnapshot,
} from "../_shared/global-usage.ts";
import { emptyUsageTotals, type SessionUsageEntry, type SessionUsageTotals } from "../_shared/usage.ts";

export interface TelemetryUsageSessionPayload {
	file: string;
	id: string;
	cwd: string;
	created: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	parentSession?: string;
	chatTurns: number;
	toolRuns: number;
	totals: GlobalModeTotals;
	total: SessionUsageTotals;
	models: GlobalModeModelRows;
}

export interface TelemetryUsageSeriesPoint {
	start: number;
	usage: SessionUsageTotals;
}

export interface TelemetryUsageSeries {
	/** Backward-compatible rolling 30-day series. */
	daily: TelemetryUsageSeriesPoint[];
	/** Backward-compatible rolling 168-hour series. */
	hourly: TelemetryUsageSeriesPoint[];
}

export interface TelemetryUsageActivitySeries {
	/** 365 local calendar days, including the current day. */
	daily: TelemetryUsageSeriesPoint[];
	/** Monday-starting weekly totals covering the daily range. */
	weekly: TelemetryUsageSeriesPoint[];
	/** Running totals for each day in the daily range. */
	cumulative: TelemetryUsageSeriesPoint[];
}

export interface TelemetryUsageModelInsight {
	model: string;
	tokens: number;
	share: number;
}

export interface TelemetryUsageOverview {
	lifetimeTokens: number;
	peakDailyTokens: number;
	peakDailyStart: number | null;
	longestChatTurns: number;
	currentStreakDays: number;
	longestStreakDays: number;
	planModeShare: number;
	mostUsedModel: TelemetryUsageModelInsight | null;
	totalToolRuns: number;
}

export interface TelemetryUsagePayload {
	scannedAt: number;
	sessionCount: number;
	modelCount: number;
	totals: GlobalModeTotals;
	total: SessionUsageTotals;
	models: GlobalModeModelRows;
	series: TelemetryUsageSeries;
	activity: TelemetryUsageActivitySeries;
	overview: TelemetryUsageOverview;
	tools: GlobalToolRow[];
	sessions: TelemetryUsageSessionPayload[];
}

export interface TelemetryUsageProgress {
	loaded: number;
	total: number;
}

export interface TelemetryUsageState {
	phase: "idle" | "scanning" | "ready" | "error";
	progress?: TelemetryUsageProgress;
	diagnostic?: string;
	data?: TelemetryUsagePayload;
}

function cloneTotals(usage: SessionUsageTotals): SessionUsageTotals {
	return { ...usage };
}

function cloneModeTotals(totals: GlobalModeTotals): GlobalModeTotals {
	return {
		main: cloneTotals(totals.main),
		plan: cloneTotals(totals.plan),
		subagent: cloneTotals(totals.subagent),
		advisor: cloneTotals(totals.advisor),
		guardian: cloneTotals(totals.guardian),
	};
}

function cloneModels(models: GlobalModeModelRows): GlobalModeModelRows {
	return {
		main: models.main.map(({ model, usage }) => ({ model, usage: cloneTotals(usage) })),
		plan: models.plan.map(({ model, usage }) => ({ model, usage: cloneTotals(usage) })),
		subagent: models.subagent.map(({ model, usage }) => ({ model, usage: cloneTotals(usage) })),
		advisor: models.advisor.map(({ model, usage }) => ({ model, usage: cloneTotals(usage) })),
		guardian: models.guardian.map(({ model, usage }) => ({ model, usage: cloneTotals(usage) })),
	};
}

function addTotals(
	target: SessionUsageTotals,
	source: Pick<SessionUsageTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "turns">,
): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
	target.tokens = target.input + target.output + target.cacheRead + target.cacheWrite;
}

function addEntry(target: SessionUsageTotals, entry: SessionUsageEntry): void {
	addTotals(target, entry);
}

function dailySeries(entries: readonly SessionUsageEntry[], now: number): TelemetryUsageSeriesPoint[] {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const points = Array.from({ length: 30 }, (_, index) => {
		const date = new Date(today);
		date.setDate(today.getDate() - (29 - index));
		return { start: date.getTime(), usage: emptyUsageTotals() };
	});
	const byStart = new Map(points.map((point) => [point.start, point]));
	for (const entry of entries) {
		if (entry.timestamp === undefined || !Number.isFinite(entry.timestamp)) continue;
		const date = new Date(entry.timestamp);
		date.setHours(0, 0, 0, 0);
		const point = byStart.get(date.getTime());
		if (point) addEntry(point.usage, entry);
	}
	return points;
}

function hourlySeries(entries: readonly SessionUsageEntry[], now: number): TelemetryUsageSeriesPoint[] {
	const currentHour = new Date(now);
	currentHour.setMinutes(0, 0, 0);
	const first = currentHour.getTime() - 167 * 60 * 60 * 1000;
	const points = Array.from({ length: 168 }, (_, index) => ({
		start: first + index * 60 * 60 * 1000,
		usage: emptyUsageTotals(),
	}));
	for (const entry of entries) {
		if (entry.timestamp === undefined || !Number.isFinite(entry.timestamp)) continue;
		const index = Math.floor((entry.timestamp - first) / (60 * 60 * 1000));
		if (index >= 0 && index < points.length) addEntry(points[index]!.usage, entry);
	}
	return points;
}

function localDateKey(timestamp: number): string | undefined {
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return undefined;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function dateFromKey(key: string, hour = 0): Date {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(year!, month! - 1, day!, hour, 0, 0, 0);
}

function dateKeyFromDate(date: Date): string {
	return localDateKey(date.getTime())!;
}

function shiftDateKey(key: string, days: number): string {
	const date = dateFromKey(key, 12);
	date.setDate(date.getDate() + days);
	return dateKeyFromDate(date);
}

function localDayStart(now: number): Date {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date;
}

function yearlyDailySeries(entries: readonly SessionUsageEntry[], now: number): TelemetryUsageSeriesPoint[] {
	const first = localDayStart(now);
	first.setDate(first.getDate() - 364);
	const points: TelemetryUsageSeriesPoint[] = [];
	const byDate = new Map<string, TelemetryUsageSeriesPoint>();
	const date = new Date(first);
	for (let index = 0; index < 365; index++) {
		const point = { start: date.getTime(), usage: emptyUsageTotals() };
		points.push(point);
		byDate.set(dateKeyFromDate(date), point);
		date.setDate(date.getDate() + 1);
	}
	for (const entry of entries) {
		if (entry.timestamp === undefined || !Number.isFinite(entry.timestamp)) continue;
		const point = byDate.get(localDateKey(entry.timestamp)!);
		if (point) addEntry(point.usage, entry);
	}
	return points;
}

function mondayDateKey(key: string): string {
	const date = dateFromKey(key, 12);
	const daysFromMonday = (date.getDay() + 6) % 7;
	date.setDate(date.getDate() - daysFromMonday);
	return dateKeyFromDate(date);
}

function weeklyActivitySeries(daily: readonly TelemetryUsageSeriesPoint[]): TelemetryUsageSeriesPoint[] {
	const points = new Map<string, TelemetryUsageSeriesPoint>();
	for (const point of daily) {
		const key = mondayDateKey(dateKeyFromDate(new Date(point.start)));
		let weekly = points.get(key);
		if (!weekly) {
			weekly = { start: dateFromKey(key).getTime(), usage: emptyUsageTotals() };
			points.set(key, weekly);
		}
		addTotals(weekly.usage, point.usage);
	}
	return [...points.values()];
}

function cumulativeActivitySeries(daily: readonly TelemetryUsageSeriesPoint[]): TelemetryUsageSeriesPoint[] {
	const cumulative = emptyUsageTotals();
	return daily.map((point) => {
		addTotals(cumulative, point.usage);
		return { start: point.start, usage: cloneTotals(cumulative) };
	});
}

function allTimeDailyTotals(entries: readonly SessionUsageEntry[]): Map<string, { start: number; usage: SessionUsageTotals }> {
	const byDate = new Map<string, { start: number; usage: SessionUsageTotals }>();
	for (const entry of entries) {
		if (entry.timestamp === undefined || !Number.isFinite(entry.timestamp)) continue;
		const key = localDateKey(entry.timestamp);
		if (!key) continue;
		let point = byDate.get(key);
		if (!point) {
			point = { start: dateFromKey(key).getTime(), usage: emptyUsageTotals() };
			byDate.set(key, point);
		}
		addEntry(point.usage, entry);
	}
	return byDate;
}

function streakMetrics(activeDates: Iterable<string>, now: number): { current: number; longest: number } {
	const dates = [...new Set(activeDates)].sort();
	const active = new Set(dates);
	let longest = 0;
	let run = 0;
	let previous: string | undefined;
	for (const key of dates) {
		if (previous && shiftDateKey(previous, 1) === key) run++;
		else run = 1;
		longest = Math.max(longest, run);
		previous = key;
	}

	const today = localDateKey(now);
	if (!today) return { current: 0, longest };
	const anchor = active.has(today) ? today : shiftDateKey(today, -1);
	if (!active.has(anchor)) return { current: 0, longest };
	let current = 0;
	let key = anchor;
	while (active.has(key)) {
		current++;
		key = shiftDateKey(key, -1);
	}
	return { current, longest };
}

function mostUsedModel(snapshot: GlobalUsageSnapshot): TelemetryUsageModelInsight | null {
	const totals = new Map<string, SessionUsageTotals>();
	for (const rows of Object.values(snapshot.models)) {
		for (const row of rows) {
			let usage = totals.get(row.model);
			if (!usage) {
				usage = emptyUsageTotals();
				totals.set(row.model, usage);
			}
			addTotals(usage, row.usage);
		}
	}
	const row = [...totals.entries()]
		.filter(([model, usage]) => model !== "unknown" && usage.tokens > 0)
		.sort((left, right) => right[1].tokens - left[1].tokens || left[0].localeCompare(right[0]))[0];
	if (!row) return null;
	return {
		model: row[0],
		tokens: row[1].tokens,
		share: snapshot.total.tokens > 0 ? row[1].tokens / snapshot.total.tokens * 100 : 0,
	};
}

function toSessionPayload(session: GlobalSessionSummary): TelemetryUsageSessionPayload {
	return {
		file: session.file,
		id: session.id,
		cwd: session.cwd,
		created: session.created,
		...(session.name === undefined ? {} : { name: session.name }),
		firstMessage: session.firstMessage,
		messageCount: session.messageCount,
		...(session.parentSession === undefined ? {} : { parentSession: session.parentSession }),
		chatTurns: session.chatTurns,
		toolRuns: session.toolRuns,
		totals: cloneModeTotals(session.totals),
		total: cloneTotals(session.total),
		models: cloneModels(session.models),
	};
}

export function toTelemetryUsagePayload(
	snapshot: GlobalUsageSnapshot,
	now = snapshot.scannedAt,
): TelemetryUsagePayload {
	const daily = yearlyDailySeries(snapshot.timeline, now);
	const dailyTotals = allTimeDailyTotals(snapshot.timeline);
	const peakCandidate = [...dailyTotals.values()].sort((left, right) =>
		right.usage.tokens - left.usage.tokens || left.start - right.start,
	)[0];
	const peak = peakCandidate && peakCandidate.usage.tokens > 0 ? peakCandidate : undefined;
	const streaks = streakMetrics(
		[...dailyTotals.entries()].filter(([, point]) => point.usage.tokens > 0).map(([key]) => key),
		now,
	);
	const activity: TelemetryUsageActivitySeries = {
		daily,
		weekly: weeklyActivitySeries(daily),
		cumulative: cumulativeActivitySeries(daily),
	};
	const model = mostUsedModel(snapshot);
	const longestChatTurns = snapshot.sessions.reduce(
		(longest, session) => Math.max(longest, session.chatTurns),
		0,
	);
	return {
		scannedAt: snapshot.scannedAt,
		sessionCount: snapshot.sessions.length,
		modelCount: snapshot.modelCount,
		totals: cloneModeTotals(snapshot.totals),
		total: cloneTotals(snapshot.total),
		models: cloneModels(snapshot.models),
		series: {
			daily: dailySeries(snapshot.timeline, now),
			hourly: hourlySeries(snapshot.timeline, now),
		},
		activity,
		overview: {
			lifetimeTokens: snapshot.total.tokens,
			peakDailyTokens: peak?.usage.tokens ?? 0,
			peakDailyStart: peak?.start ?? null,
			longestChatTurns,
			currentStreakDays: streaks.current,
			longestStreakDays: streaks.longest,
			planModeShare: snapshot.total.tokens > 0 ? snapshot.totals.plan.tokens / snapshot.total.tokens * 100 : 0,
			mostUsedModel: model,
			totalToolRuns: snapshot.toolRunCount,
		},
		tools: snapshot.tools.slice(0, 5).map((row) => ({ ...row })),
		sessions: snapshot.sessions.map(toSessionPayload),
	};
}
