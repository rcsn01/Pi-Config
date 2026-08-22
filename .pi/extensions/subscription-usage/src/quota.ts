import { finite, record } from "./probe.ts";
import type { QuotaSnapshot, QuotaWindow } from "./types.ts";

function timestamp(value: unknown): string | undefined {
	const numeric = finite(value);
	if (numeric !== undefined) {
		const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
		const result = new Date(milliseconds);
		return Number.isFinite(result.getTime()) ? result.toISOString() : undefined;
	}
	if (typeof value !== "string" || !value.trim()) return undefined;
	const result = new Date(value);
	return Number.isFinite(result.getTime()) ? result.toISOString() : undefined;
}

// Port of codex `window_minutes_from_seconds` (codex-rs/backend-client/src/client.rs):
// ceil(seconds / 60), non-positive seconds yield no window duration.
export function windowMinutesFromSeconds(seconds: unknown): number | undefined {
	const value = finite(seconds);
	if (value === undefined || value <= 0) return undefined;
	return Math.ceil(value / 60);
}

function isApproximateWindow(minutes: number, expectedMinutes: number): boolean {
	return minutes >= expectedMinutes * 0.95 && minutes <= expectedMinutes * 1.05;
}

// Port of codex `get_limits_duration` (codex-rs/tui/src/chatwidget/rate_limits.rs):
// classifies a window by its length in minutes with ±5% tolerance.
export function getLimitsDuration(windowMinutes: number): string | undefined {
	const minutes = Math.max(0, windowMinutes);
	if (isApproximateWindow(minutes, 300)) return "5h";
	if (isApproximateWindow(minutes, 1_440)) return "daily";
	if (isApproximateWindow(minutes, 10_080)) return "weekly";
	if (isApproximateWindow(minutes, 43_200)) return "monthly";
	if (isApproximateWindow(minutes, 525_600)) return "annual";
	return undefined;
}

function matchesWindowLabel(window: QuotaWindow, label: string): boolean {
	return window.windowMinutes !== undefined && getLimitsDuration(window.windowMinutes) === label;
}

// Port of codex `weekly_status_window` (codex-rs/tui/src/chatwidget/status_surfaces.rs):
// prefer a window labeled "weekly" (primary, then secondary), else fall back to the
// secondary window, else no weekly limit is available.
export function selectWeeklyWindow(
	primary: QuotaWindow | undefined,
	secondary: QuotaWindow | undefined,
): QuotaWindow | undefined {
	if (primary && matchesWindowLabel(primary, "weekly")) return primary;
	if (secondary && matchesWindowLabel(secondary, "weekly")) return secondary;
	return secondary;
}

// Port of codex `plan_type_display_name` (codex-rs/tui/src/status/helpers.rs):
// Team-like → "Business", Business-like → "Enterprise", ProLite → "Pro Lite",
// EnterpriseCbpAutomation → "Enterprise (Automation)", else title-cased raw value.
const TEAM_LIKE = new Set(["team", "self_serve_business_prolite", "self_serve_business_usage_based"]);
const BUSINESS_LIKE = new Set(["business", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based"]);

function titleCase(value: string): string {
	return value ? value[0]!.toUpperCase() + value.slice(1).toLowerCase() : value;
}

export function planTypeDisplayName(raw: string): string {
	const normalized = raw.trim().toLowerCase().replace(/([a-z0-9])([A-Z])/g, "$1_$2");
	if (normalized === "enterprise_cbp_automation") return "Enterprise (Automation)";
	if (TEAM_LIKE.has(normalized)) return "Business";
	if (BUSINESS_LIKE.has(normalized)) return "Enterprise";
	if (normalized === "pro_lite") return "Pro Lite";
	return normalized.split("_").filter(Boolean).map(titleCase).join(" ");
}

function windowOf(value: unknown): QuotaWindow | undefined {
	const source = record(value);
	if (!source) return undefined;
	const usedPercent = finite(source.used_percent);
	if (usedPercent === undefined) return undefined;
	const windowMinutes = windowMinutesFromSeconds(source.limit_window_seconds);
	const resetsAt = timestamp(source.reset_at);
	return {
		usedPercent,
		...(windowMinutes !== undefined ? { windowMinutes } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

// The client guarantees the root contract (string `plan_type`, object `rate_limit`)
// before calling this; anything deeper that fails to parse simply yields no row.
export function normalizeQuota(payload: unknown, fetchedAt: string): QuotaSnapshot | undefined {
	const root = record(payload);
	const rateLimit = record(root?.rate_limit);
	if (!root || typeof root.plan_type !== "string" || !rateLimit) return undefined;
	const plan = root.plan_type.trim() ? planTypeDisplayName(root.plan_type) : undefined;
	const resetCredits = record(root.rate_limit_reset_credits);
	const available = resetCredits ? finite(resetCredits.available_count) : undefined;
	const applicable = resetCredits ? finite(resetCredits.applicable_available_count) : undefined;
	return {
		...(plan !== undefined ? { plan } : {}),
		weekly: selectWeeklyWindow(windowOf(rateLimit.primary_window), windowOf(rateLimit.secondary_window)),
		...(resetCredits && available !== undefined
			? { resetCredits: { available, ...(applicable !== undefined ? { applicable } : {}) } }
			: {}),
		fetchedAt,
	};
}
