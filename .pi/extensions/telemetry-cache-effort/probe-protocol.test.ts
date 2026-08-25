import { describe, expect, it } from "vitest";
import { validatePayloads } from "./child-runner.ts";
import {
	fingerprintPayload,
	parseProbeLine,
	serializeProbeEvent,
	stableHash,
} from "./probe-protocol.ts";

describe("child probe protocol", () => {
	it("hashes canonical objects without retaining payload text", () => {
		expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
		const observation = fingerprintPayload({
			model: "gpt-test",
			prompt_cache_key: "secret-session-key",
			instructions: "synthetic instructions",
			input: [{ role: "user", content: "long synthetic prompt" }],
			reasoning: { effort: "medium", summary: "auto" },
		}, 1);
		expect(JSON.stringify(observation)).not.toContain("secret-session-key");
		expect(JSON.stringify(observation)).not.toContain("long synthetic prompt");
		expect(observation.effectiveEffort).toBe("medium");
	});

	it("round-trips marked stderr events and ignores ordinary stderr", () => {
		const event = { type: "turn" as const, requestIndex: 2, wireMode: "delta" as const };
		expect(parseProbeLine(serializeProbeEvent(event).trim())).toEqual(event);
		expect(parseProbeLine("provider warning")).toBeUndefined();
	});

	it("validates stable keys, normalized request fields, input prefixes, and real effort changes", () => {
		const payloads = [
			fingerprintPayload({ prompt_cache_key: "key", input: [{ n: 1 }], reasoning: { effort: "medium" } }, 1),
			fingerprintPayload({ prompt_cache_key: "key", input: [{ n: 1 }, { n: 2 }], reasoning: { effort: "medium" } }, 2),
			fingerprintPayload({ prompt_cache_key: "key", input: [{ n: 1 }, { n: 2 }, { n: 3 }], reasoning: { effort: "max" } }, 3),
			fingerprintPayload({ prompt_cache_key: "key", input: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], reasoning: { effort: "max" } }, 4),
		];
		expect(validatePayloads(payloads)).toEqual([]);
		expect(validatePayloads(payloads.map((payload, index) => index === 2 ? { ...payload, promptCacheKeyHash: "changed" } : payload)))
			.toContain("prompt_cache_key changed within the trial.");
	});
});
