import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ObservabilityEvent, ObservabilityService } from "../observability.ts";
import { createChildObservation } from "./index.ts";

const baseLaunch = {
	args: ["--mode", "json", "Task: inspect"],
	env: { PATH: "/bin" },
	stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
};

function observability(active: boolean, publish = vi.fn()): ObservabilityService {
	return {
		isActive: () => active,
		publish,
		subscribe: () => () => undefined,
		activate: () => () => undefined,
	};
}

function childWithRelay(): { child: ChildProcess; relay: PassThrough } {
	const child = new EventEmitter() as ChildProcess;
	const relay = new PassThrough();
	(child as unknown as { stdio: Array<PassThrough | null> }).stdio = [null, new PassThrough(), new PassThrough(), relay, null];
	return { child, relay };
}

describe("Child observation module", () => {
	it("returns copied, unchanged launch values and an inert attachment when capture is inactive", () => {
		const prepared = createChildObservation(observability(false)).prepare(baseLaunch, {
			channel: "subagent",
			displayLabel: "worker",
		});

		expect(prepared.args).toEqual(baseLaunch.args);
		expect(prepared.args).not.toBe(baseLaunch.args);
		expect(prepared.env).toEqual(baseLaunch.env);
		expect(prepared.env).not.toBe(baseLaunch.env);
		expect(prepared.stdio).toEqual(baseLaunch.stdio);
		expect(prepared.stdio).not.toBe(baseLaunch.stdio);
		expect(() => prepared.attach(new EventEmitter() as ChildProcess)).not.toThrow();
	});

	it("decorates an active child launch and publishes bounded, source-attributed events", () => {
		const publish = vi.fn();
		const prepared = createChildObservation(observability(true, publish)).prepare(baseLaunch, {
			channel: "subagent",
			displayLabel: "worker",
		});
		const { child, relay } = childWithRelay();
		prepared.attach(child);

		expect(prepared.args.slice(-2)[0]).toBe("--extension");
		expect(prepared.args.at(-1)).toMatch(/_shared\/child-observation\/child-extension\.ts$/);
		expect(prepared.env).toMatchObject({ PATH: "/bin", PI_CHILD_OBSERVATION_FD: "3" });
		expect(prepared.stdio).toEqual(["ignore", "pipe", "pipe", "pipe"]);

		const request = JSON.stringify({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { exact: true } });
		relay.write("{bad}\n" + JSON.stringify({ type: "agent_start" }) + "\n" + request.slice(0, 17));
		relay.write(request.slice(17) + "\n" + JSON.stringify({ type: "response", status: 200 }) + "\n");
		relay.write("x".repeat(8 * 1024 * 1024 + 1));
		relay.write("\n" + JSON.stringify({ type: "turn_start", turnIndex: 4 }) + "\n");
		const unicode = Buffer.from(JSON.stringify({ type: "assistant", message: { role: "assistant", content: "café" } }) + "\n");
		const split = unicode.indexOf(Buffer.from("é")) + 1;
		relay.write(unicode.subarray(0, split));
		relay.end(unicode.subarray(split));

		const events = publish.mock.calls.map(([event]) => event as ObservabilityEvent);
		expect(events.map((event) => event.type)).toEqual(["agent_start", "request", "response", "turn_start", "assistant"]);
		expect(events[1]).toMatchObject({
			source: { channel: "subagent", displayLabel: "worker" },
			payload: { exact: true },
		});
		expect(new Set(events.map((event) => event.source.invocationId)).size).toBe(1);
	});

	it("assigns an isolated source to each prepared child", async () => {
		const publish = vi.fn();
		const module = createChildObservation(observability(true, publish));
		const first = module.prepare(baseLaunch, { channel: "subagent", displayLabel: "first" });
		const second = module.prepare(baseLaunch, { channel: "subagent", displayLabel: "second" });
		const firstChild = childWithRelay();
		const secondChild = childWithRelay();
		first.attach(firstChild.child);
		second.attach(secondChild.child);
		firstChild.relay.end(JSON.stringify({ type: "agent_start" }));
		secondChild.relay.end(JSON.stringify({ type: "agent_start" }));

		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
		const sources = publish.mock.calls.map(([event]) => (event as ObservabilityEvent).source);
		expect(sources.map((source) => source.displayLabel)).toEqual(["first", "second"]);
		expect(sources[0].invocationId).not.toBe(sources[1].invocationId);
	});

	it("falls back to an unchanged launch when preparation fails", () => {
		const broken = observability(false);
		broken.isActive = () => { throw new Error("capture unavailable"); };
		const prepared = createChildObservation(broken).prepare(baseLaunch, {
			channel: "subagent",
			displayLabel: "worker",
		});
		expect(prepared).toMatchObject(baseLaunch);
		expect(() => prepared.attach(new EventEmitter() as ChildProcess)).not.toThrow();
	});

	it("isolates publication failures and ignores invalid or repeated attachments", async () => {
		const publish = vi.fn(() => { throw new Error("listener failed"); });
		const prepared = createChildObservation(observability(true, publish)).prepare(baseLaunch, {
			channel: "guardian",
			displayLabel: "child",
		});
		const invalid = new EventEmitter() as ChildProcess;
		(invalid as unknown as { stdio: null[] }).stdio = [null, null, null, null, null];
		expect(() => prepared.attach(invalid)).not.toThrow();

		const first = childWithRelay();
		const second = childWithRelay();
		prepared.attach(first.child);
		prepared.attach(second.child);
		expect(() => first.relay.end(JSON.stringify({ type: "agent_start" }))).not.toThrow();
		second.relay.end(JSON.stringify({ type: "turn_start", turnIndex: 2 }));
		await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
	});
});
