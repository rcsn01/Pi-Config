import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	writeSync: vi.fn((_fd: number, _buffer: Uint8Array, _offset: number, length: number) => length),
}));

vi.mock("node:fs", () => ({ writeSync: mocks.writeSync }));

import childObservationExtension from "./child-extension.ts";

type Handler = (...args: any[]) => void;

function extensionHarness(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	return {
		pi: {
			on: vi.fn((event: string, handler: Handler) => {
				handlers.set(event, handler);
			}),
		} as unknown as ExtensionAPI,
		handlers,
	};
}

function writtenEvents(): Record<string, unknown>[] {
	return mocks.writeSync.mock.calls.map(([, buffer]) => JSON.parse(Buffer.from(buffer).toString("utf8")));
}

beforeEach(() => {
	mocks.writeSync.mockReset();
	mocks.writeSync.mockImplementation((_fd, _buffer, _offset, length) => length);
	process.env.PI_CHILD_OBSERVATION_FD = "3";
});

afterEach(() => {
	delete process.env.PI_CHILD_OBSERVATION_FD;
});

describe("Child observation Pi adapter", () => {
	it("relays the five observed Pi event types", () => {
		const { pi, handlers } = extensionHarness();
		childObservationExtension(pi);

		handlers.get("agent_start")!();
		handlers.get("turn_start")!({ turnIndex: 2, timestamp: 123 });
		handlers.get("before_provider_request")!({ payload: { prompt: true } }, {
			model: { provider: "openai", api: "openai-responses", id: "gpt" },
		});
		handlers.get("after_provider_response")!({ status: 200 });
		handlers.get("message_end")!({ message: { role: "assistant", content: "done" } });

		expect(writtenEvents()).toEqual([
			{ type: "agent_start" },
			{ type: "turn_start", turnIndex: 2, at: 123 },
			{ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { prompt: true } },
			{ type: "response", status: 200 },
			{ type: "assistant", message: { role: "assistant", content: "done" } },
		]);
	});

	it("does not register without a valid inherited pipe and stops after a write failure", () => {
		process.env.PI_CHILD_OBSERVATION_FD = "invalid";
		const inactive = extensionHarness();
		childObservationExtension(inactive.pi);
		expect(inactive.handlers.size).toBe(0);

		process.env.PI_CHILD_OBSERVATION_FD = "3";
		const active = extensionHarness();
		childObservationExtension(active.pi);
		mocks.writeSync.mockImplementationOnce(() => { throw new Error("closed"); });
		expect(() => active.handlers.get("agent_start")!()).not.toThrow();
		active.handlers.get("agent_start")!();
		expect(mocks.writeSync).toHaveBeenCalledOnce();
	});
});
