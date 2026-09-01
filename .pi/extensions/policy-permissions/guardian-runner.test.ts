import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	collectGuardianUsage,
	parseGuardianDefinition,
	parseGuardianVerdict,
	runAutoReviewer,
	type GuardianPromptSession,
} from "./guardian-runner.ts";

const GUARDIAN_CONTENT = "---\nname: guardian\nmodel: test/guardian-1\n---\n\nYou are the guardian.\n";
const tempDir = mkdtempSync(join(tmpdir(), "pi-guardian-runner-"));
const guardianPath = join(tempDir, "guardian.md");
writeFileSync(guardianPath, GUARDIAN_CONTENT);

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const REQUEST_USAGE = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 18,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

interface FakeSessionPlan {
	/** Assistant text appended while the prompt runs. */
	text?: string;
	/** Usage attached to that assistant message. */
	usage?: typeof REQUEST_USAGE;
	/** Thrown by prompt after the message (if any) is appended. */
	error?: Error;
	/** Prompt never settles (streamed usage may still land in messages). */
	never?: boolean;
	/** Delay before prompt settles, to hold the review lock. */
	holdMs?: number;
	/** Model reported by the session; null means no model. */
	model?: { provider: string; id: string } | null;
	/** Messages already in the session when the review acquires it. */
	prior?: Array<{ text: string; usage?: typeof REQUEST_USAGE }>;
	onPromptStart?: () => void;
	onPromptEnd?: () => void;
}

function fakeSession(plan: FakeSessionPlan = {}) {
	const messages: any[] = (plan.prior ?? []).map((entry) => ({
		role: "assistant",
		content: entry.text,
		...(entry.usage ? { usage: entry.usage } : {}),
	}));
	const abort = vi.fn(async () => {});
	const session: GuardianPromptSession = {
		model: plan.model === null ? undefined : plan.model ?? { provider: "test", id: "guardian-1" },
		get messages() {
			return messages;
		},
		prompt: vi.fn(async () => {
			plan.onPromptStart?.();
			try {
				if (plan.holdMs) await new Promise((resolve) => setTimeout(resolve, plan.holdMs));
				if (plan.text !== undefined || plan.usage) {
					messages.push({
						role: "assistant",
						content: plan.text ?? "",
						...(plan.usage ? { usage: plan.usage } : {}),
					});
				}
				if (plan.error) throw plan.error;
				if (plan.never) await new Promise(() => {});
			} finally {
				plan.onPromptEnd?.();
			}
		}),
		abort,
	};
	return { session, abort };
}

function review(plan: FakeSessionPlan = {}, options: { timeoutMs?: number } = {}) {
	const built = fakeSession(plan);
	const promise = runAutoReviewer(
		"Test action",
		"rm -rf /tmp/scratch",
		{ ...options, sessionFactory: async () => built.session },
		guardianPath,
	);
	return { ...built, promise };
}

describe("collectGuardianUsage", () => {
	it("aggregates assistant usage only from the current guardian request", () => {
		const messages = [
			{ role: "assistant", usage: { input: 999, output: 999, cacheRead: 999, cacheWrite: 0, totalTokens: 1_998, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 } } },
			{ role: "user" },
			{ role: "assistant", usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } } },
			{ role: "assistant", usage: { input: 5, output: 4, cacheRead: 6, cacheWrite: 0, totalTokens: 15, cost: { input: 0.5, output: 0.4, cacheRead: 0.6, cacheWrite: 0, total: 1.5 } } },
		] as any;

		expect(collectGuardianUsage(messages, 1)).toEqual({
			input: 15,
			output: 6,
			cacheRead: 9,
			cacheWrite: 1,
			totalTokens: 30,
			cost: { input: 0.6, output: 0.6000000000000001, cacheRead: 0.8999999999999999, cacheWrite: 0.4, total: 2.5 },
		});
		expect(collectGuardianUsage(messages, 0)?.input).toBe(1014);
		expect(collectGuardianUsage([{ role: "user" }] as any, 0)).toBeUndefined();
	});
});

describe("parseGuardianVerdict", () => {
	it("parses a JSON allow verdict with rationale", () => {
		expect(parseGuardianVerdict('{"outcome":"allow","risk_level":"low","rationale":"safe read"}')).toEqual({
			allowed: true,
			reason: "safe read",
		});
	});

	it("parses a JSON deny verdict with risk and rationale", () => {
		const result = parseGuardianVerdict('{"outcome":"deny","risk_level":"high","rationale":"deletes files"}');
		expect(result).not.toBe("unclear");
		expect(result).toMatchObject({ allowed: false });
		expect((result as { reason: string }).reason).toContain("deletes files");
	});

	it("strips markdown fences around JSON verdicts", () => {
		expect(parseGuardianVerdict('```json\n{"outcome":"allow"}\n```')).toEqual({
			allowed: true,
			reason: "allowed",
		});
	});

	it("accepts a bare ALLOW token", () => {
		expect(parseGuardianVerdict("I think this is fine. ALLOW")).toEqual({
			allowed: true,
			reason: "Guardian: allowed.",
		});
	});

	it("accepts a bare DENY token", () => {
		expect(parseGuardianVerdict("This is unsafe. DENY.")).toEqual({
			allowed: false,
			reason: "Guardian: denied.",
		});
	});

	it("returns 'unclear' for ambiguous responses", () => {
		expect(parseGuardianVerdict("I am not sure what to do here.")).toBe("unclear");
	});
});

describe("parseGuardianDefinition", () => {
	it("parses CRLF frontmatter and the guardian system prompt", () => {
		const definition = parseGuardianDefinition(
			"---\r\nname: guardian\r\nmodel: test/model\r\ntools:\r\n---\r\n\r\nReview this action.\r\n",
		);

		expect(definition).toEqual({
			systemPrompt: "Review this action.",
			model: "test/model",
			tools: "",
		});
	});

	it("handles a definition without a model or tools", () => {
		expect(parseGuardianDefinition("---\n---\n\nJust a prompt.")).toEqual({
			systemPrompt: "Just a prompt.",
			model: "",
			tools: "",
		});
	});
});

describe("runAutoReviewer decision matrix", () => {
	it("returns parsed allow and deny verdicts", async () => {
		const allowed = review({ text: '{"outcome":"allow","rationale":"safe read"}' });
		const allow = await allowed.promise;
		expect(allow).toMatchObject({ allowed: true, reason: "safe read" });
		expect(allowed.session.prompt).toHaveBeenCalledWith(expect.stringContaining("Title: Test action"));
		expect(allowed.session.prompt).toHaveBeenCalledWith(expect.stringContaining("rm -rf /tmp/scratch"));

		const denied = review({ text: '{"outcome":"deny","risk_level":"high","rationale":"deletes files"}' });
		const deny = await denied.promise;
		expect(deny).toMatchObject({
			allowed: false,
			reason: "risk: high | deletes files",
		});
	});

	it("fails closed on empty and ambiguous responses", async () => {
		const empty = await review({ text: "" }).promise;
		expect(empty).toMatchObject({
			allowed: false,
			reason: "Guardian returned no response; blocked for safety.",
		});

		const silent = await review({}).promise;
		expect(silent).toMatchObject({
			allowed: false,
			reason: "Guardian returned no response; blocked for safety.",
		});

		const ambiguous = await review({ text: "I am not sure what to do here." }).promise;
		expect(ambiguous).toMatchObject({
			allowed: false,
			reason: "Guardian returned ambiguous response; blocked for safety.",
		});
	});

	it("fails closed with a safe reason when the session throws or the guardian is unusable", async () => {
		const thrown = await review({ error: new Error("provider exploded") }).promise;
		expect(thrown).toMatchObject({ allowed: false, reason: "Guardian error: provider exploded" });

		const missing = await runAutoReviewer(
			"Test action",
			"message",
			{ sessionFactory: async () => fakeSession().session },
			join(tempDir, "missing-guardian.md"),
		);
		expect(missing).toMatchObject({
			allowed: false,
			reason: "Guardian agent not found; blocked for safety.",
		});

		const emptyPromptPath = join(tempDir, "empty-guardian.md");
		writeFileSync(emptyPromptPath, "---\nname: guardian\n---\n\n");
		const emptyPrompt = await runAutoReviewer(
			"Test action",
			"message",
			{ sessionFactory: async () => fakeSession().session },
			emptyPromptPath,
		);
		expect(emptyPrompt).toMatchObject({
			allowed: false,
			reason: "Guardian agent has no system prompt; blocked for safety.",
		});
	});

	it("fails closed on timeout, aborting the session best-effort", async () => {
		vi.useFakeTimers();
		try {
			const timedOut = review({ never: true, usage: REQUEST_USAGE }, { timeoutMs: 5000 });
			const pending = timedOut.promise;
			await vi.advanceTimersByTimeAsync(5000);
			const result = await pending;
			expect(result).toMatchObject({
				allowed: false,
				reason: "Guardian timed out after 5s; blocked for safety.",
			});
			expect(timedOut.abort).toHaveBeenCalledOnce();

			// A failing abort is swallowed; the review still fails closed.
			const stranded = fakeSession({ never: true });
			stranded.abort.mockRejectedValue(new Error("abort failed"));
			const pendingAbort = runAutoReviewer(
				"Test action",
				"message",
				{ sessionFactory: async () => stranded.session, timeoutMs: 4000 },
				guardianPath,
			);
			await vi.advanceTimersByTimeAsync(4000);
			await expect(pendingAbort).resolves.toMatchObject({ allowed: false });
			expect(stranded.abort).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("attributes model and request usage on success and failure", async () => {
		const success = await review({
			text: '{"outcome":"allow"}',
			usage: REQUEST_USAGE,
			model: { provider: "anthropic", id: "claude-guardian" },
			prior: [{ text: "previous turn", usage: { ...REQUEST_USAGE, input: 999 } }],
		}).promise;
		expect(success.model).toBe("anthropic/claude-guardian");
		// Only the current request's usage is attributed, not the prior turn's.
		expect(success.usage).toMatchObject({ input: 10, output: 5, totalTokens: 18 });

		const failure = await review({ usage: REQUEST_USAGE, error: new Error("boom") }).promise;
		expect(failure.model).toBe("test/guardian-1");
		expect(failure.usage).toMatchObject({ input: 10 });

		const unattributed = await review({ text: '{"outcome":"allow"}', model: null }).promise;
		expect("model" in unattributed).toBe(false);
		expect("usage" in unattributed).toBe(false);
	});

	it("serializes concurrent reviews through the shared lock", async () => {
		let active = 0;
		let maxActive = 0;
		const factory = vi.fn(async (): Promise<GuardianPromptSession> =>
			fakeSession({
				text: '{"outcome":"allow"}',
				holdMs: 15,
				onPromptStart: () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
				},
				onPromptEnd: () => {
					active -= 1;
				},
			}).session,
		);

		const [first, second] = await Promise.all([
			runAutoReviewer("a", "action a", { sessionFactory: factory }, guardianPath),
			runAutoReviewer("b", "action b", { sessionFactory: factory }, guardianPath),
		]);

		expect(maxActive).toBe(1);
		expect(first.allowed).toBe(true);
		expect(second.allowed).toBe(true);
		expect(factory).toHaveBeenCalledTimes(2);
	});
});
