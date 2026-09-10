import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	Provider,
	StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HEADROOM_BASE_URL,
	HEADROOM_READY_URL,
	HEADROOM_UPSTREAM_HEADER,
	createHeadroomExtension,
	createHeadroomProvider,
	probeHeadroom,
	removeHeader,
	setHeader,
} from "./index.ts";

const COPILOT_ID = "github-copilot";
const CODEX_ID = "openai-codex";
const EFFECTIVE_COPILOT_URL = "https://enterprise.example/copilot";
const CODEX_URL = "https://chatgpt.com/backend-api";

function emptyStream(): AssistantMessageEventStream {
	return {
		async *[Symbol.asyncIterator]() {},
	} as unknown as AssistantMessageEventStream;
}

function streamOf(...events: AssistantMessageEvent[]): AssistantMessageEventStream {
	return {
		async *[Symbol.asyncIterator]() {
			yield* events;
		},
	} as unknown as AssistantMessageEventStream;
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function makeModel(provider: string, baseUrl: string, headers?: Record<string, string>): Model<Api> {
	return {
		id: "test-model",
		name: "Test model",
		api: provider === COPILOT_ID ? "openai-responses" : "openai-codex-responses",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
		headers,
	};
}

function makeProvider(providerId: string, modelBaseUrl: string) {
	const models = [makeModel(providerId, modelBaseUrl)];
	const auth = {
		apiKey: {
			name: "test auth",
			resolve: vi.fn(async () => undefined),
		},
	};
	const getModels = vi.fn(() => models);
	const filterModels = vi.fn((entries: readonly Model<Api>[]) => entries);
	const refreshModels = vi.fn(async () => {});
	const stream = vi.fn((_model: Model<Api>, _context: Context, _options?: StreamOptions) => emptyStream());
	const streamSimple = vi.fn((_model: Model<Api>, _context: Context, _options?: StreamOptions) => emptyStream());
	const fetchDeferred = vi.fn(() => emptyStream());
	const cancelDeferred = vi.fn(async () => {});
	const provider: Provider<Api> = {
		id: providerId,
		name: "Native test provider",
		baseUrl: modelBaseUrl,
		headers: { "provider-header": "preserved" },
		auth,
		getModels,
		refreshModels,
		filterModels,
		stream,
		streamSimple,
		fetchDeferred,
		cancelDeferred,
	};
	return {
		provider,
		model: models[0]!,
		models,
		auth,
		getModels,
		filterModels,
		refreshModels,
		stream,
		streamSimple,
		fetchDeferred,
		cancelDeferred,
	};
}

async function dispatch(
	provider: Provider<Api>,
	method: "stream" | "streamSimple",
	model: Model<Api>,
	opts?: StreamOptions,
): Promise<AssistantMessageEvent[]> {
	const context: Context = { messages: [] };
	const stream = method === "stream" ? provider.stream(model, context, opts) : provider.streamSimple(model, context, opts);
	return collectEvents(stream);
}

function errorEvent(message = "proxy failed"): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: COPILOT_ID,
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	};
}

function response(ok: boolean, body: unknown): Response {
	return {
		ok,
		status: ok ? 200 : 503,
		json: vi.fn(async () => body),
	} as unknown as Response;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("headers", () => {
	it("handles header names case-insensitively", () => {
		const original = {
			"X-Headroom-Base-URL": "old",
			"x-headroom-base-url": "older",
			ordinary: "kept",
		};

		expect(setHeader(original, HEADROOM_UPSTREAM_HEADER, EFFECTIVE_COPILOT_URL)).toEqual({
			ordinary: "kept",
			[HEADROOM_UPSTREAM_HEADER]: EFFECTIVE_COPILOT_URL,
		});
		expect(removeHeader(original, HEADROOM_UPSTREAM_HEADER)).toEqual({ ordinary: "kept" });
		expect(original).toEqual({
			"X-Headroom-Base-URL": "old",
			"x-headroom-base-url": "older",
			ordinary: "kept",
		});
	});
});

describe("createHeadroomProvider", () => {
	it("preserves native provider fields and methods", () => {
		const native = makeProvider(COPILOT_ID, EFFECTIVE_COPILOT_URL);
		const wrapped = createHeadroomProvider(native.provider, { probe: async () => false });

		expect(wrapped.id).toBe(native.provider.id);
		expect(wrapped.name).toBe(native.provider.name);
		expect(wrapped.baseUrl).toBe(native.provider.baseUrl);
		expect(wrapped.headers).toBe(native.provider.headers);
		expect(wrapped.auth).toBe(native.auth);
		expect(wrapped.getModels).toBe(native.getModels);
		expect(wrapped.getModels()).toBe(native.models);
		expect(wrapped.filterModels).toBe(native.filterModels);
		expect(wrapped.refreshModels).toBe(native.refreshModels);
		expect(wrapped.fetchDeferred).toBe(native.fetchDeferred);
		expect(wrapped.cancelDeferred).toBe(native.cancelDeferred);
		expect(wrapped.stream).not.toBe(native.stream);
		expect(wrapped.streamSimple).not.toBe(native.streamSimple);
	});

	it.each(["stream", "streamSimple"] as const)("routes healthy Copilot %s through the proxy", async (method) => {
		const native = makeProvider(COPILOT_ID, "https://catalog.example/copilot");
		const probe = vi.fn(async () => true);
		const wrapped = createHeadroomProvider(native.provider, { probe });
		const model = makeModel(COPILOT_ID, EFFECTIVE_COPILOT_URL, {
			"X-Headroom-Base-URL": "model-attacker-value",
			"copilot-model-header": "preserved",
		});
		const options: StreamOptions = {
			apiKey: "copilot-access-token",
			headers: {
				Authorization: "Bearer copilot-access-token",
				"X-HEADROOM-BASE-URL": "options-attacker-value",
				"copilot-request-header": "preserved",
			},
		};

		await dispatch(wrapped, method, model, options);

		const [requestModel, _context] = native[method].mock.calls[0]!;
		const requestOptions = native[method].mock.calls[0]![2]!;
		expect(requestModel.baseUrl).toBe(HEADROOM_BASE_URL);
		expect(requestModel.headers).toEqual({ "copilot-model-header": "preserved" });
		expect(requestOptions.apiKey).toBe("copilot-access-token");
		expect(requestOptions.headers).toEqual({
			Authorization: "Bearer copilot-access-token",
			"copilot-request-header": "preserved",
			[HEADROOM_UPSTREAM_HEADER]: EFFECTIVE_COPILOT_URL,
		});
		expect(model.baseUrl).toBe(EFFECTIVE_COPILOT_URL);
		expect(options.headers).toHaveProperty("X-HEADROOM-BASE-URL", "options-attacker-value");
		expect(probe).toHaveBeenCalledOnce();
	});

	it("falls back for Copilot and strips internal headers", async () => {
		const native = makeProvider(COPILOT_ID, "https://catalog.example/copilot");
		const wrapped = createHeadroomProvider(native.provider, { probe: async () => false });
		const model = makeModel(COPILOT_ID, EFFECTIVE_COPILOT_URL, {
			"X-HEADROOM-BASE-URL": "model-attacker-value",
			"copilot-model-header": "preserved",
		});
		const options: StreamOptions = {
			headers: {
				"x-Headroom-Base-Url": "options-attacker-value",
				"copilot-request-header": "preserved",
			},
		};

		await dispatch(wrapped, "stream", model, options);

		const [requestModel, _context] = native.stream.mock.calls[0]!;
		const requestOptions = native.stream.mock.calls[0]![2]!;
		expect(requestModel.baseUrl).toBe(EFFECTIVE_COPILOT_URL);
		expect(requestModel.headers).toEqual({ "copilot-model-header": "preserved" });
		expect(requestOptions.headers).toEqual({ "copilot-request-header": "preserved" });
	});

	it("routes healthy Codex without the Copilot header", async () => {
		const native = makeProvider(CODEX_ID, CODEX_URL);
		const wrapped = createHeadroomProvider(native.provider, { probe: async () => true });
		const model = makeModel(CODEX_ID, CODEX_URL, { "account-header": "account-id" });
		const options: StreamOptions = {
			apiKey: "codex-access-token",
			headers: {
				Authorization: "Bearer codex-access-token",
				"account-header": "account-id",
				"X-Headroom-Base-URL": "caller-value",
			},
		};

		await dispatch(wrapped, "streamSimple", model, options);

		const [requestModel, _context] = native.streamSimple.mock.calls[0]!;
		const requestOptions = native.streamSimple.mock.calls[0]![2]!;
		expect(requestModel.baseUrl).toBe(HEADROOM_BASE_URL);
		expect(requestOptions.apiKey).toBe("codex-access-token");
		expect(requestOptions.headers).toEqual({
			Authorization: "Bearer codex-access-token",
			"account-header": "account-id",
		});
	});

	it("falls back for Codex without the internal header", async () => {
		const native = makeProvider(CODEX_ID, CODEX_URL);
		const wrapped = createHeadroomProvider(native.provider, { probe: async () => false });
		const model = makeModel(CODEX_ID, CODEX_URL, { "X-HEADROOM-BASE-URL": "model-value" });
		const options: StreamOptions = { headers: { "x-headroom-base-url": "options-value" } };

		await dispatch(wrapped, "stream", model, options);

		const [requestModel, _context] = native.stream.mock.calls[0]!;
		const requestOptions = native.stream.mock.calls[0]![2]!;
		expect(requestModel.baseUrl).toBe(CODEX_URL);
		expect(requestModel.headers).toEqual({});
		expect(requestOptions.headers).toEqual({});
	});

	it("falls back on probe errors but honors cancellation", async () => {
		const native = makeProvider(COPILOT_ID, EFFECTIVE_COPILOT_URL);
		const probe = vi.fn(async () => {
			throw new Error("connection refused");
		});
		const wrapped = createHeadroomProvider(native.provider, { probe });

		await dispatch(wrapped, "stream", native.model, {});
		expect(native.stream).toHaveBeenCalledOnce();
		expect(native.stream.mock.calls[0]![0].baseUrl).toBe(EFFECTIVE_COPILOT_URL);

		const controller = new AbortController();
		const pendingProbe = vi.fn(
			async (_signal?: AbortSignal) =>
				new Promise<boolean>(() => {}),
		);
		const cancelled = createHeadroomProvider(native.provider, { probe: pendingProbe });
		const streamPromise = dispatch(cancelled, "stream", native.model, { signal: controller.signal });
		controller.abort();
		const events = await streamPromise;

		expect(pendingProbe).toHaveBeenCalledOnce();
		expect(native.stream).toHaveBeenCalledOnce();
		expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
	});

	it("does not probe or dispatch an already-aborted request", async () => {
		const native = makeProvider(COPILOT_ID, EFFECTIVE_COPILOT_URL);
		const probe = vi.fn(async () => true);
		const wrapped = createHeadroomProvider(native.provider, { probe });
		const controller = new AbortController();
		controller.abort();

		const events = await dispatch(wrapped, "streamSimple", native.model, { signal: controller.signal });

		expect(probe).not.toHaveBeenCalled();
		expect(native.streamSimple).not.toHaveBeenCalled();
		expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
	});

	it("does not replay a proxy failure", async () => {
		const native = makeProvider(COPILOT_ID, EFFECTIVE_COPILOT_URL);
		const failure = errorEvent();
		native.stream.mockImplementation(() => streamOf(failure));
		const wrapped = createHeadroomProvider(native.provider, { probe: async () => true });

		const events = await dispatch(wrapped, "stream", native.model, {});

		expect(events).toEqual([failure]);
		expect(native.stream).toHaveBeenCalledOnce();
		expect(native.stream.mock.calls[0]![0].baseUrl).toBe(HEADROOM_BASE_URL);
	});

	it("logs only when the selected route changes", async () => {
		const native = makeProvider(COPILOT_ID, EFFECTIVE_COPILOT_URL);
		const probe = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const wrapped = createHeadroomProvider(native.provider, { probe });
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		for (let i = 0; i < 4; i++) await dispatch(wrapped, "stream", native.model, {});

		expect(warning).toHaveBeenCalledOnce();
		expect(info).toHaveBeenCalledOnce();
		expect(warning.mock.calls.flat().join(" ")).not.toContain(EFFECTIVE_COPILOT_URL);
		expect(info.mock.calls.flat().join(" ")).not.toContain(EFFECTIVE_COPILOT_URL);
	});
});

describe("probeHeadroom", () => {
	it("accepts only a ready response", async () => {
		const fetch = vi.fn(async () => response(true, { ready: true }));
		vi.stubGlobal("fetch", fetch);

		expect(await probeHeadroom()).toBe(true);
		expect(fetch).toHaveBeenCalledWith(HEADROOM_READY_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
	});

	it("treats false readiness, bad status, and malformed JSON as unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response(true, { ready: false }))
				.mockResolvedValueOnce(response(false, { ready: true }))
				.mockResolvedValueOnce({ ok: true, json: vi.fn(async () => { throw new Error("bad json"); }) }),
		);

		expect(await probeHeadroom()).toBe(false);
		expect(await probeHeadroom()).toBe(false);
		expect(await probeHeadroom()).toBe(false);
	});

	it("treats connection errors and timeout as unavailable", async () => {
		const fetch = vi.fn().mockRejectedValueOnce(new Error("connection refused"));
		vi.stubGlobal("fetch", fetch);
		expect(await probeHeadroom()).toBe(false);

		vi.useFakeTimers();
		const never = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
				}),
		);
		vi.stubGlobal("fetch", never);
		const pending = probeHeadroom();
		await vi.advanceTimersByTimeAsync(500);
		expect(await pending).toBe(false);
	});

	it("does not turn cancellation into an unavailable result", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const pending = probeHeadroom(controller.signal);
		controller.abort();

		await expect(pending).rejects.toThrow("Request was aborted");
	});
});

describe("createHeadroomExtension", () => {
	it("registers exactly the native Copilot and Codex provider ids", () => {
		const registrations: Provider[] = [];
		const pi = {
			registerProvider: vi.fn((provider: Provider) => registrations.push(provider)),
		} as unknown as ExtensionAPI;

		createHeadroomExtension({ probe: async () => false })(pi);

		expect(registrations.map((provider) => provider.id)).toEqual([COPILOT_ID, CODEX_ID]);
	});
});
