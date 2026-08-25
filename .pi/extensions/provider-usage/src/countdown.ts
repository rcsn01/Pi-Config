// Shared "resets in X on <date>" formatting for every usage row, mirroring
// the Ollama web UI's compact countdown style (2h 15m, 3d 4h) plus the reset
// date (on 24 Aug). All reset instants are known exactly: Codex exposes
// resetsAt, and the Ollama boundaries are computed (next full hour / next
// week boundary from the API anchor).
const MONTH_ABBREVIATIONS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Compact duration: 40m, 1h, 2h 45m, 6d, 6d 4h. Rounds up to whole minutes. */
export function formatCountdown(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	if (hours < 24) return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/** Day + month: "24 Aug" (same style as the old Codex reset label). */
export function formatDate(date: Date): string {
	return `${date.getDate()} ${MONTH_ABBREVIATIONS[date.getMonth()]}`;
}

/** Full label for an exact reset instant: "resets in 2h 45m on 24 Aug". */
export function resetsInText(at: Date, now = new Date()): string {
	return `resets in ${formatCountdown(at.getTime() - now.getTime())} on ${formatDate(at)}`;
}
