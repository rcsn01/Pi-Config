/**
 * Startup and command-specific helpers for the custom /model selector.
 *
 * The model, thinking, and context picker lives in the shared model-picker
 * module so advisor and executor selection cannot drift apart.
 */

export {
	contextWindowChoices,
	filterModels,
	findExactModel,
	formatTokenCount,
	THINKING_DESCRIPTIONS,
} from "../_shared/model-picker.ts";
export type { ModelChoiceLike } from "../_shared/model-selection.ts";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export function hasExplicitModelArgument(argv: readonly string[]): boolean {
	return argv.some((argument) => argument === "--model" || argument.startsWith("--model="));
}

export function shouldOpenStartupModelSelector(
	reason: SessionStartReason,
	hasConversationHistory: boolean,
	argv: readonly string[],
): boolean {
	if (hasExplicitModelArgument(argv)) return false;
	if (reason === "new") return true;
	return reason === "startup" && !hasConversationHistory;
}
