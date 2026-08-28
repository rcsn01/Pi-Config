/** Pi adapter for one Guardian review execution. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAutoReviewer, type GuardianReviewResult } from "./guardian-runner.ts";
import type { GuardianSettings } from "./guardian-settings.ts";

export async function runGuardianReview(
	ctx: ExtensionContext,
	settings: GuardianSettings | undefined,
	title: string,
	evaluationMessage: string,
): Promise<GuardianReviewResult> {
	const nativeProvider = settings && typeof ctx.modelRegistry?.getRegisteredNativeProvider === "function"
		? ctx.modelRegistry.getRegisteredNativeProvider(settings.provider)
		: undefined;
	const providerConfig = settings && typeof ctx.modelRegistry?.getRegisteredProviderConfig === "function"
		? ctx.modelRegistry.getRegisteredProviderConfig(settings.provider)
		: undefined;
	const providerRegistration = nativeProvider || providerConfig
		? { native: nativeProvider, config: providerConfig }
		: undefined;
	return runAutoReviewer(title, evaluationMessage, {
		settings,
		...(providerRegistration ? { providerRegistration } : {}),
	});
}
