import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
	ObservabilityChannel,
	ObservabilityEvent,
	ObservabilityService,
	ObservabilitySource,
} from "../observability.ts";

const CHILD_EXTENSION_PATH = fileURLToPath(new URL("./child-extension.ts", import.meta.url));
const CHILD_OBSERVATION_FD = 3;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

type ChildStdio = ["ignore", "pipe", "pipe"];
type ObservedChildStdio = ["ignore", "pipe", "pipe", "pipe"];
type RelayedEvent = ObservabilityEvent extends infer Event
	? Event extends ObservabilityEvent
		? Omit<Event, "source">
		: never
	: never;

export interface ChildPiLaunch {
	args: readonly string[];
	env?: NodeJS.ProcessEnv;
	stdio: ChildStdio;
}

export interface ChildObservationSource {
	channel: ObservabilityChannel;
	displayLabel: string;
}

export interface PreparedChildObservation {
	args: string[];
	env?: NodeJS.ProcessEnv;
	stdio: ChildStdio | ObservedChildStdio;
	attach(child: ChildProcess): void;
}

export interface ChildObservation {
	prepare(launch: ChildPiLaunch, source: ChildObservationSource): PreparedChildObservation;
}

function copiedLaunch(launch: ChildPiLaunch): Omit<PreparedChildObservation, "attach"> {
	return {
		args: [...launch.args],
		...(launch.env === undefined ? {} : { env: { ...launch.env } }),
		stdio: [...launch.stdio],
	};
}

function validString(value: unknown): value is string {
	return typeof value === "string" && value.length <= 1024;
}

function parseFrame(line: string): RelayedEvent | undefined {
	if (!line || Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return undefined;
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		if (!event || typeof event !== "object") return undefined;
		const at = event.at;
		if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at))) return undefined;
		if (event.type === "agent_start") return { type: "agent_start", ...(at === undefined ? {} : { at }) };
		if (event.type === "turn_start" && typeof event.turnIndex === "number" && Number.isInteger(event.turnIndex)) {
			return { type: "turn_start", turnIndex: event.turnIndex, ...(at === undefined ? {} : { at }) };
		}
		if (event.type === "request" && validString(event.provider) && validString(event.api) && validString(event.model) && "payload" in event) {
			return {
				type: "request",
				provider: event.provider,
				api: event.api,
				model: event.model,
				payload: event.payload,
				...(at === undefined ? {} : { at }),
			};
		}
		if (event.type === "response" && (event.status === undefined || (typeof event.status === "number" && Number.isInteger(event.status)))) {
			return { type: "response", ...(event.status === undefined ? {} : { status: event.status }), ...(at === undefined ? {} : { at }) };
		}
		if (event.type === "assistant" && "message" in event) {
			return { type: "assistant", message: event.message, ...(at === undefined ? {} : { at }) };
		}
	} catch {}
	return undefined;
}

function createFrameReader(forward: (event: RelayedEvent) => void): { push(chunk: Buffer | string): void; end(): void } {
	let buffer = "";
	let discarding = false;
	let ended = false;
	const decoder = new StringDecoder("utf8");
	const processLine = (line: string) => {
		const event = parseFrame(line.trimEnd());
		if (event) forward(event);
	};
	const feed = (input: string) => {
		let text = input;
		while (text) {
			const newline = text.indexOf("\n");
			const part = newline < 0 ? text : text.slice(0, newline);
			text = newline < 0 ? "" : text.slice(newline + 1);
			if (!discarding) {
				const nextBytes = Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(part, "utf8");
				if (nextBytes > MAX_FRAME_BYTES) {
					buffer = "";
					discarding = true;
				} else {
					buffer += part;
				}
			}
			if (newline >= 0) {
				if (!discarding) processLine(buffer);
				buffer = "";
				discarding = false;
			}
		}
	};
	return {
		push(chunk) {
			if (!ended) feed(typeof chunk === "string" ? chunk : decoder.write(chunk));
		},
		end() {
			if (ended) return;
			ended = true;
			feed(decoder.end());
			if (!discarding && buffer.trim()) processLine(buffer);
			buffer = "";
			discarding = false;
		},
	};
}

export function createChildObservation(observability: ObservabilityService): ChildObservation {
	return {
		prepare(launch, sourceDescriptor) {
			const base = copiedLaunch(launch);
			try {
				if (!observability.isActive()) return { ...base, attach: () => undefined };
				const source: ObservabilitySource = { ...sourceDescriptor, invocationId: randomUUID() };
				let attached = false;
				return {
					args: [...base.args, "--extension", CHILD_EXTENSION_PATH],
					env: { ...process.env, ...base.env, PI_CHILD_OBSERVATION_FD: String(CHILD_OBSERVATION_FD) },
					stdio: ["ignore", "pipe", "pipe", "pipe"],
					attach(child) {
						if (attached) return;
						try {
							const stream = child.stdio[CHILD_OBSERVATION_FD] as Readable | null | undefined;
							if (!stream || typeof stream.on !== "function") return;
							attached = true;
							const reader = createFrameReader((event) => {
								try {
									observability.publish({ ...event, source } as ObservabilityEvent);
								} catch {}
							});
							stream.on("data", (chunk: Buffer) => reader.push(chunk));
							stream.once("end", () => reader.end());
							stream.once("close", () => reader.end());
							child.once("close", () => reader.end());
							child.once("error", () => reader.end());
						} catch {}
					},
				};
			} catch {
				return { ...base, attach: () => undefined };
			}
		},
	};
}
