import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ runAutoReviewer: vi.fn() }));
vi.mock("./guardian-runner.ts", () => mocked);

import { createApprovalService } from "./approvals.ts";

const usage = {
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 1,
	totalTokens: 16,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

describe("guardian approval persistence", () => {
	it("persists guardian usage on the existing verdict message without transcript data", async () => {
		mocked.runAutoReviewer.mockResolvedValue({ allowed: true, reason: "safe", model: "openai/guardian", usage });
		const sendMessage = vi.fn();
		const service = createApprovalService({
			getMode: () => ({ mode: "auto-review", setAt: 0 }),
			getContext: () => ({ lastUserPrompt: "Review this", precedingAssistantMessage: "I will inspect it" }),
			sendMessage,
		});

		const result = await service.guardianReview({ hasUI: true } as any, "Read file", "Read /tmp/example.txt");

		expect(result).toEqual({ allowed: true, reason: "safe" });
		expect(sendMessage).toHaveBeenCalledWith({
			customType: "auto-review-verdict",
			content: "✅ ALLOWED: Read file — safe",
			display: true,
			details: { title: "Read file", allowed: true, reason: "safe", model: "openai/guardian", usage },
		});
	});
});
