// Text progress bar for usage rows: `[████████████░░░░░░░░]` — 20 segments,
// each worth 5 percentage points. Both the filled and empty tracks are boxes
// in different shades: the solid full block (█) and the light shade (░).
// The notification boundary remains plain text. Rounds to the nearest segment
// and clamps to the bar width (usage can exceed 100% when over the limit).
export const BAR_WIDTH = 20;

const FILLED = "█";
const EMPTY = "░";

export function usageBar(usedPercent: number, width = BAR_WIDTH): string {
	const filled = Math.min(width, Math.max(0, Math.round(usedPercent / (100 / width))));
	return `[${FILLED.repeat(filled)}${EMPTY.repeat(width - filled)}]`;
}
