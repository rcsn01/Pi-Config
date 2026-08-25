export type ObservabilityChannel = "main" | "subagent" | "guardian" | "compaction";

export interface ObservabilitySource {
	channel: ObservabilityChannel;
	invocationId: string;
	displayLabel: string;
}

export type ObservabilityEvent =
	| { type: "agent_start"; source: ObservabilitySource; at?: number }
	| { type: "turn_start"; source: ObservabilitySource; turnIndex: number; at?: number }
	| { type: "request"; source: ObservabilitySource; provider: string; api: string; model: string; payload: unknown; fidelity?: "exact-provider" | "pi-preparation"; at?: number }
	| { type: "response"; source: ObservabilitySource; status?: number; at?: number }
	| { type: "assistant"; source: ObservabilitySource; message: unknown; at?: number };

export type ObservabilityListener = (event: ObservabilityEvent) => void;

export interface ObservabilityService {
	isActive(): boolean;
	publish(event: ObservabilityEvent): void;
	subscribe(listener: ObservabilityListener): () => void;
	activate(listener: ObservabilityListener): () => void;
}

interface ServiceState {
	listeners: Set<ObservabilityListener>;
	activeListeners: Set<ObservabilityListener>;
}

const SERVICE_KEY = Symbol.for("pi.extensions.provider-observability.v1");

function state(): ServiceState {
	const globals = globalThis as typeof globalThis & { [SERVICE_KEY]?: ServiceState };
	const serviceState = globals[SERVICE_KEY] ??= { listeners: new Set(), activeListeners: new Set() };
	serviceState.activeListeners ??= new Set();
	return serviceState;
}

export function getObservabilityService(): ObservabilityService {
	return {
		isActive: () => state().activeListeners.size > 0,
		publish(event) {
			for (const listener of [...state().listeners]) {
				try {
					listener(event);
				} catch {
					// Observability is optional and must not affect the observed operation.
				}
			}
		},
		subscribe(listener) {
			state().listeners.add(listener);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				state().listeners.delete(listener);
			};
		},
		activate(listener) {
			state().listeners.add(listener);
			state().activeListeners.add(listener);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				state().activeListeners.delete(listener);
				state().listeners.delete(listener);
			};
		},
	};
}

/** Test-only reset for the process-global singleton. */
export function resetObservabilityServiceForTests(): void {
	state().listeners.clear();
	state().activeListeners.clear();
}
