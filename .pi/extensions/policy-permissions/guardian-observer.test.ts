import { beforeEach, describe, expect, it } from "vitest";
import { getObservabilityService, resetObservabilityServiceForTests } from "../_shared/observability.ts";
import { guardianObserverExtension, runWithGuardianObservation } from "./guardian-observer.ts";

beforeEach(() => resetObservabilityServiceForTests());

function harness() {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	guardianObserverExtension({ on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as any);
	return handlers;
}

describe("guardian inline observer", () => {
	it("forwards exact request, HTTP response, lifecycle, and assistant events for the current review", async () => {
		const events: any[] = [];
		getObservabilityService().subscribe((event) => events.push(event));
		const handlers = harness();
		const source = { channel: "guardian", invocationId: "review-1", displayLabel: "Guardian" } as const;
		const payload = { input: [{ role: "user", content: "secret" }], temperature: 0 };
		const assistant = { role: "assistant", content: [{ type: "text", text: "allow" }], usage: { input: 5, output: 1 } };
		await runWithGuardianObservation(source, async () => {
			handlers.get("agent_start")!({});
			handlers.get("turn_start")!({ turnIndex: 0, timestamp: 10 });
			handlers.get("before_provider_request")!({ payload }, { model: { provider: "openai", api: "openai-responses", id: "guardian-model" } });
			handlers.get("after_provider_response")!({ status: 204 });
			handlers.get("message_end")!({ message: assistant });
		});
		expect(events.map((event) => event.type)).toEqual(["agent_start", "turn_start", "request", "response", "assistant"]);
		expect(events[2]).toMatchObject({ source, payload, provider: "openai", model: "guardian-model" });
		expect(events[3].status).toBe(204);
		expect(events[4].message).toBe(assistant);
	});

	it("uses distinct review identities and stays inactive outside a review scope", async () => {
		const events: any[] = [];
		getObservabilityService().subscribe((event) => events.push(event));
		const handlers = harness();
		handlers.get("agent_start")!({});
		for (const invocationId of ["review-a", "review-b"]) {
			await runWithGuardianObservation({ channel: "guardian", invocationId, displayLabel: "Guardian" }, async () => {
				handlers.get("agent_start")!({});
			});
		}
		expect(events.map((event) => event.source.invocationId)).toEqual(["review-a", "review-b"]);
	});
});
