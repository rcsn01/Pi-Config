import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ runAutoReviewer: vi.fn() }));
vi.mock("./guardian-runner.ts", () => mocked);

import { runGuardianReview } from "./approvals.ts";
import type { GuardianReviewRequest } from "./guardian-evidence.ts";

const usage = {
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 1,
	totalTokens: 16,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

describe("Guardian review adapter", () => {
	it("runs with profile settings and native provider registration", async () => {
		mocked.runAutoReviewer.mockResolvedValue({
			allowed: true,
			reason: "safe",
			model: "openai/guardian",
			usage,
		});
		const settings = {
			provider: "openai",
			modelId: "guardian",
			thinkingLevel: "high" as const,
			contextWindow: 256_000,
		};
		const native = { id: "native" };
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: vi.fn(() => native),
				getRegisteredProviderConfig: vi.fn(),
			},
		} as any;

		const request: GuardianReviewRequest = {
			conversation: { messages: [], askUserInteractions: [], omittedEarlierUserTurns: 0, truncated: false },
			action: {
				title: "Read file",
				description: "evaluation context",
				descriptionTruncated: false,
				triggers: ["external-path"],
			},
		};
		const result = await runGuardianReview(ctx, settings, request);

		expect(result).toEqual({
			allowed: true,
			reason: "safe",
			model: "openai/guardian",
			usage,
		});
		expect(mocked.runAutoReviewer).toHaveBeenCalledWith(request, {
			settings,
			providerRegistration: { native, config: undefined },
		});
		expect(mocked.runAutoReviewer.mock.calls[0]?.[0]).toBe(request);
	});

	it("runs without provider registration when none is available", async () => {
		mocked.runAutoReviewer.mockResolvedValue({ allowed: false, reason: "unsafe" });
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: vi.fn(),
				getRegisteredProviderConfig: vi.fn(),
			},
		} as any;
		const request: GuardianReviewRequest = {
			conversation: { messages: [], askUserInteractions: [], omittedEarlierUserTurns: 0, truncated: false },
			action: {
				title: "Command",
				description: "context",
				descriptionTruncated: false,
				triggers: ["dangerous"],
			},
		};
		expect(await runGuardianReview(ctx, undefined, request))
			.toEqual({ allowed: false, reason: "unsafe" });
		expect(mocked.runAutoReviewer).toHaveBeenCalledWith(request, { settings: undefined });
	});
});
