import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import { getObservabilityService, type ObservabilityEvent, type ObservabilitySource } from "../_shared/observability.ts";

const invocation = new AsyncLocalStorage<ObservabilitySource>();

export function runWithGuardianObservation<T>(source: ObservabilitySource | undefined, operation: () => Promise<T>): Promise<T> {
	return source ? invocation.run(source, operation) : operation();
}

type WithoutSource<T> = T extends unknown ? Omit<T, "source"> : never;

export function guardianObserverExtension(pi: ExtensionAPI): void {
	const observability = getObservabilityService();
	const publish = (event: WithoutSource<ObservabilityEvent>) => {
		const source = invocation.getStore();
		if (source) observability.publish({ ...event, source } as Parameters<typeof observability.publish>[0]);
	};

	pi.on("agent_start", () => publish({ type: "agent_start" }));
	pi.on("turn_start", (event) => publish({ type: "turn_start", turnIndex: event.turnIndex, at: event.timestamp }));
	pi.on("before_provider_request", (event, ctx) => {
		if (!ctx.model) return;
		publish({ type: "request", provider: ctx.model.provider, api: ctx.model.api, model: ctx.model.id, payload: event.payload });
	});
	pi.on("after_provider_response", (event) => publish({ type: "response", status: event.status }));
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") publish({ type: "assistant", message: event.message });
	});
}
