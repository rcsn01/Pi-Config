import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAssistantMessageEventStream, lazyStream } from "@earendil-works/pi-ai";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	Provider,
	SimpleStreamOptions,
	StreamOptions,
} from "@earendil-works/pi-ai";

export const HEADROOM_BASE_URL = "http://127.0.0.1:8787/v1";
export const HEADROOM_READY_URL = "http://127.0.0.1:8787/readyz";
export const HEADROOM_UPSTREAM_HEADER = "x-headroom-base-url";

const HEADROOM_READY_TIMEOUT_MS = 500;
const COPILOT_PROVIDER_ID = "github-copilot";

type HeaderRecord = Record<string, string | null>;
type Route = "headroom" | "direct";

export interface HeadroomAdapterDependencies {
	probe?: (signal?: AbortSignal) => Promise<boolean>;
}

interface RouteState {
	lastRoute?: Route;
}

export function setHeader<T extends HeaderRecord>(headers: T | undefined, name: string, value: string): T {
	const result = { ...(headers ?? {}) } as T;
	const expected = name.toLowerCase();
	for (const key of Object.keys(result)) {
		if (key.toLowerCase() === expected) delete result[key];
	}
	(result as HeaderRecord)[name] = value;
	return result;
}

export function removeHeader<T extends HeaderRecord>(headers: T | undefined, name: string): T | undefined {
	if (!headers) return undefined;
	const result = { ...headers } as T;
	const expected = name.toLowerCase();
	for (const key of Object.keys(result)) {
		if (key.toLowerCase() === expected) delete result[key];
	}
	return result;
}

function requestAbortedError(): Error {
	const error = new Error("Request was aborted");
	error.name = "AbortError";
	return error;
}

function abortedStream<TApi extends Api>(model: Model<TApi>): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "aborted", error: message });
	stream.end(message);
	return stream;
}

function isReadyBody(body: unknown): boolean {
	return typeof body === "object" && body !== null && !Array.isArray(body) && "ready" in body && body.ready === true;
}

export async function probeHeadroom(signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) throw requestAbortedError();

	const timeoutController = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const readiness = (async (): Promise<boolean> => {
		try {
			const response = await fetch(HEADROOM_READY_URL, { signal: timeoutController.signal });
			if (!response.ok) {
				try {
					await response.body?.cancel();
				} catch {
					// The readiness result is already false. There is no useful error to expose.
				}
				return false;
			}
			const body = await response.json();
			return isReadyBody(body);
		} catch {
			return false;
		}
	})();
	const timeoutResult = new Promise<boolean>((resolve) => {
		timeout = setTimeout(() => {
			timeoutController.abort();
			resolve(false);
		}, HEADROOM_READY_TIMEOUT_MS);
	});
	const cancellationResult = signal
		? new Promise<boolean>((resolve) => {
			onAbort = () => {
				timeoutController.abort();
				resolve(false);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		})
		: undefined;

	try {
		const result = await Promise.race(
			cancellationResult ? [readiness, timeoutResult, cancellationResult] : [readiness, timeoutResult],
		);
		if (signal?.aborted) throw requestAbortedError();
		return result;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

function noteRoute(state: RouteState, route: Route): void {
	if (state.lastRoute === "headroom" && route === "direct") {
		console.warn("[provider-headroom] Headroom became unavailable; using direct provider fallback.");
	} else if (state.lastRoute === "direct" && route === "headroom") {
		console.info("[provider-headroom] Headroom is available again; routing through Headroom.");
	}
	state.lastRoute = route;
}

function routeModelAndOptions<TApi extends Api, TOptions extends StreamOptions>(
	providerId: string,
	model: Model<TApi>,
	options: TOptions | undefined,
	ready: boolean,
): { model: Model<TApi>; options: TOptions | undefined } {
	const modelHeaders = removeHeader(model.headers, HEADROOM_UPSTREAM_HEADER);
	const optionsHeaders = removeHeader(options?.headers, HEADROOM_UPSTREAM_HEADER);
	const requestModel: Model<TApi> = {
		...model,
		baseUrl: ready ? HEADROOM_BASE_URL : model.baseUrl,
		headers: modelHeaders,
	};

	if (ready && providerId === COPILOT_PROVIDER_ID) {
		const headers = setHeader(optionsHeaders, HEADROOM_UPSTREAM_HEADER, model.baseUrl);
		return {
			model: requestModel,
			options: { ...(options ?? {}), headers } as TOptions,
		};
	}
	return {
		model: requestModel,
		options: options ? ({ ...options, headers: optionsHeaders } as TOptions) : undefined,
	};
}

function createRouteState(): RouteState {
	return {};
}

function createHeadroomProviderWithState<TApi extends Api>(
	provider: Provider<TApi>,
	dependencies: HeadroomAdapterDependencies,
	state: RouteState,
): Provider<TApi> {
	const probe = dependencies.probe ?? probeHeadroom;

	async function probeForRequest(signal?: AbortSignal): Promise<boolean> {
		if (!signal) return probe();
		if (signal.aborted) throw requestAbortedError();

		let onAbort: (() => void) | undefined;
		const cancellation = new Promise<boolean>((_resolve, reject) => {
			onAbort = () => reject(requestAbortedError());
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		const probeResult = Promise.resolve().then(() => probe(signal));
		try {
			return await Promise.race([probeResult, cancellation]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	async function prepare<TModelApi extends TApi, TOptions extends StreamOptions>(
		model: Model<TModelApi>,
		options: TOptions | undefined,
	): Promise<{ model: Model<TModelApi>; options: TOptions | undefined }> {
		if (options?.signal?.aborted) throw requestAbortedError();

		let ready = false;
		try {
			ready = (await probeForRequest(options?.signal)) === true;
		} catch {
			if (options?.signal?.aborted) throw requestAbortedError();
		}
		if (options?.signal?.aborted) throw requestAbortedError();

		noteRoute(state, ready ? "headroom" : "direct");
		return routeModelAndOptions(provider.id, model, options, ready);
	}

	const wrapped: Provider<TApi> = {
		...provider,
		stream: <TModelApi extends TApi>(
			model: Model<TModelApi>,
			context: Context,
			options?: ApiStreamOptions<TModelApi>,
		): AssistantMessageEventStream =>
			lazyStream(model, async (): Promise<AsyncIterable<AssistantMessageEvent>> => {
				try {
					const routed = await prepare(model, options);
					return provider.stream(routed.model, context, routed.options);
				} catch (error) {
					if (options?.signal?.aborted) return abortedStream(model);
					throw error;
				}
			}),
		streamSimple: (model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream =>
			lazyStream(model, async (): Promise<AsyncIterable<AssistantMessageEvent>> => {
				try {
					const routed = await prepare(model, options);
					return provider.streamSimple(routed.model, context, routed.options);
				} catch (error) {
					if (options?.signal?.aborted) return abortedStream(model);
					throw error;
				}
			}),
	};
	return wrapped;
}

export function createHeadroomProvider<TApi extends Api>(
	provider: Provider<TApi>,
	dependencies: HeadroomAdapterDependencies = {},
): Provider<TApi> {
	return createHeadroomProviderWithState(provider, dependencies, createRouteState());
}

export function createHeadroomExtension(dependencies: HeadroomAdapterDependencies = {}) {
	return (pi: ExtensionAPI): void => {
		const state = createRouteState();
		const probe = dependencies.probe ?? probeHeadroom;
		pi.registerProvider(
			createHeadroomProviderWithState(githubCopilotProvider(), { probe }, state),
		);
		pi.registerProvider(
			createHeadroomProviderWithState(openaiCodexProvider(), { probe }, state),
		);
	};
}

export default createHeadroomExtension();
