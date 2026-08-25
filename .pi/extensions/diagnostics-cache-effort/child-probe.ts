import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fingerprintPayload, serializeProbeEvent } from "./probe-protocol.ts";

interface WebSocketStats {
	requests: number;
	fullContextRequests: number;
	deltaRequests: number;
	sseFallbacks: number;
	[key: string]: number | string | boolean | undefined;
}

type ReadDebugStats = (sessionId: string) => WebSocketStats | undefined;

function readPackage(pathname: string): { name?: string; version?: string } | undefined {
	try {
		return JSON.parse(fs.readFileSync(pathname, "utf8")) as { name?: string; version?: string };
	} catch {
		return undefined;
	}
}

function findPiRoot(entry: string | undefined): string | undefined {
	if (!entry) return undefined;
	let directory: string;
	try {
		directory = path.dirname(fs.realpathSync(entry));
	} catch {
		return undefined;
	}
	while (true) {
		const manifest = readPackage(path.join(directory, "package.json"));
		if (manifest?.name === "@earendil-works/pi-coding-agent") return directory;
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

async function loadRuntimeDebug(): Promise<{
	read?: ReadDebugStats;
	piVersion?: string;
	piAiVersion?: string;
	error?: string;
}> {
	try {
		const piRoot = findPiRoot(process.argv[1]);
		if (!piRoot) throw new Error("Could not locate the installed Pi package.");
		const adapterPath = path.join(
			piRoot,
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		if (!fs.existsSync(adapterPath)) throw new Error("Installed Pi AI WebSocket adapter was not found.");
		const module = await import(pathToFileURL(adapterPath).href) as {
			getOpenAICodexWebSocketDebugStats?: ReadDebugStats;
		};
		const piAiRoot = path.resolve(path.dirname(adapterPath), "../..");
		return {
			read: module.getOpenAICodexWebSocketDebugStats,
			piVersion: readPackage(path.join(piRoot, "package.json"))?.version,
			piAiVersion: readPackage(path.join(piAiRoot, "package.json"))?.version,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function safeStats(stats: WebSocketStats | undefined): Record<string, number | boolean | undefined> | undefined {
	if (!stats) return undefined;
	return {
		requests: stats.requests,
		connectionsCreated: typeof stats.connectionsCreated === "number" ? stats.connectionsCreated : undefined,
		connectionsReused: typeof stats.connectionsReused === "number" ? stats.connectionsReused : undefined,
		fullContextRequests: stats.fullContextRequests,
		deltaRequests: stats.deltaRequests,
		sseFallbacks: stats.sseFallbacks,
		websocketFailures: typeof stats.websocketFailures === "number" ? stats.websocketFailures : undefined,
		websocketFallbackActive: typeof stats.websocketFallbackActive === "boolean" ? stats.websocketFallbackActive : undefined,
	};
}

function classifyWireMode(previous: WebSocketStats | undefined, current: WebSocketStats | undefined) {
	if (!current) return "unknown" as const;
	const before = previous ?? { requests: 0, fullContextRequests: 0, deltaRequests: 0, sseFallbacks: 0 };
	if (current.sseFallbacks > before.sseFallbacks) return "sse-fallback" as const;
	if (current.deltaRequests > before.deltaRequests) return "delta" as const;
	if (current.fullContextRequests > before.fullContextRequests) return "full" as const;
	return "unknown" as const;
}

export default async function (pi: ExtensionAPI) {
	const runtime = await loadRuntimeDebug();
	process.stderr.write(serializeProbeEvent({
		type: "runtime",
		observation: {
			piVersion: runtime.piVersion,
			piAiVersion: runtime.piAiVersion,
			websocketDebugAvailable: typeof runtime.read === "function",
			websocketDebugError: runtime.error,
		},
	}));

	let requestIndex = 0;
	let previousStats: WebSocketStats | undefined;

	pi.on("before_provider_request", (event) => {
		requestIndex++;
		process.stderr.write(serializeProbeEvent({
			type: "request",
			observation: fingerprintPayload(event.payload, requestIndex),
		}));
		// Read-only instrumentation: returning undefined preserves the exact payload.
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const stats = runtime.read?.(ctx.sessionManager.getSessionId()) as WebSocketStats | undefined;
		const wireMode = process.env.PI_CACHE_EFFORT_TRANSPORT === "auto"
			? classifyWireMode(previousStats, stats)
			: "unknown";
		process.stderr.write(serializeProbeEvent({
			type: "turn",
			requestIndex,
			wireMode,
			websocketStats: safeStats(stats),
		}));
		previousStats = stats;
	});
}
