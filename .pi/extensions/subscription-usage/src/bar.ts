// Text progress bar for usage rows: `[▰▰▰▰▰▱▱▱▱▱]` — 10 segments, each
// worth 10 percentage points. Uses the light block pair (▰ filled / ▱
// empty) so the bar reads brighter than the heavy █/░ blocks. Rounds to
// the nearest segment and clamps to the bar width (usage can exceed 100%
// when over the limit).
export const BAR_WIDTH = 10;

const FILLED = "▰";
const EMPTY = "▱";

export function usageBar(usedPercent: number, width = BAR_WIDTH): string {
	const filled = Math.min(width, Math.max(0, Math.round(usedPercent / (100 / width))));
	return `[${FILLED.repeat(filled)}${EMPTY.repeat(width - filled)}]`;
}
