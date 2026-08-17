// Text progress bar for usage rows: `[██████░░░░]` — 10 segments, each
// worth 10 percentage points. Both the filled and empty tracks are boxes in
// different shades: the solid full block (█) and the light shade (░). The
// brightening (bold, color) is applied by the ANSI style layer at the notify
// boundary (style.ts), not here. Rounds to the nearest segment and clamps to
// the bar width (usage can exceed 100% when over the limit).
export const BAR_WIDTH = 10;

const FILLED = "█";
const EMPTY = "░";

export function usageBar(usedPercent: number, width = BAR_WIDTH): string {
	const filled = Math.min(width, Math.max(0, Math.round(usedPercent / (100 / width))));
	return `[${FILLED.repeat(filled)}${EMPTY.repeat(width - filled)}]`;
}
