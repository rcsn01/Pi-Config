import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ runAutoReviewer: vi.fn() }));
vi.mock("./guardian-runner.ts", () => mocked);

import { runGuardianReview } from "./approvals.ts";

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

		const result = await runGuardianReview(ctx, settings, "Read file", "evaluation context");

		expect(result).toEqual({
			allowed: true,
			reason: "safe",
			model: "openai/guardian",
			usage,
		});
		expect(mocked.runAutoReviewer).toHaveBeenCalledWith("Read file", "evaluation context", {
			settings,
			providerRegistration: { native, config: undefined },
		});
	});

	it("runs without provider registration when none is available", async () => {
		mocked.runAutoReviewer.mockResolvedValue({ allowed: false, reason: "unsafe" });
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: vi.fn(),
				getRegisteredProviderConfig: vi.fn(),
			},
		} as any;
		expect(await runGuardianReview(ctx, undefined, "Command", "context"))
			.toEqual({ allowed: false, reason: "unsafe" });
		expect(mocked.runAutoReviewer).toHaveBeenCalledWith("Command", "context", { settings: undefined });
	});
});
