import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_REQUEST_LIFECYCLE_CLIENT } from "./dashboard-request-lifecycle.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function browserContext(options: {
	hash?: string;
	search?: string;
	fetch?: typeof fetch;
} = {}) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const replaceState = vi.fn();
	Object.assign(window, {
		AbortController,
		location: { hash: options.hash ?? "#token=secret", pathname: "/dashboard", search: options.search ?? "?view=all" },
		history: { replaceState },
		fetch: options.fetch ?? vi.fn(),
	});
	const context = vm.createContext(window);
	vm.runInContext(`${DASHBOARD_REQUEST_LIFECYCLE_CLIENT}\nglobalThis.lifecycle = createDashboardRequestLifecycle();`, context);
	return { lifecycle: (window as any).lifecycle, replaceState };
}

async function flush() {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("Dashboard request lifecycle", () => {
	it("returns null without a token and leaves browser history unchanged", () => {
		const { lifecycle, replaceState } = browserContext({ hash: "" });
		expect(lifecycle).toBeNull();
		expect(replaceState).not.toHaveBeenCalled();
	});

	it("removes the token, forces authorization, decodes JSON, and normalizes HTTP failures", async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", json: async () => ({ ready: true }) })
			.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" })
			.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Unavailable" });
		const { lifecycle, replaceState } = browserContext({ fetch });

		expect(replaceState).toHaveBeenCalledWith(null, "", "/dashboard?view=all");
		await expect(lifecycle.mutate("save", "/api/save", {
			method: "POST",
			headers: { authorization: "Bearer wrong", "X-Test": "yes" },
		})).resolves.toEqual({ ready: true });
		expect(fetch).toHaveBeenNthCalledWith(1, "/api/save", expect.objectContaining({ method: "POST" }));
		const headers = fetch.mock.calls[0]![1].headers as Headers;
		expect(headers.get("Authorization")).toBe("Bearer secret");
		expect(headers.get("X-Test")).toBe("yes");
		await expect(lifecycle.mutate("clear", "/api/clear", { method: "POST" })).resolves.toBeNull();
		await expect(lifecycle.mutate("retry", "/api/retry", { method: "POST" })).rejects.toMatchObject({
			name: "DashboardRequestError",
			kind: "http",
			status: 503,
			statusText: "Unavailable",
			message: "HTTP 503 Unavailable",
		});
	});

	it("accepts Headers and tuple-array header forms", async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" })
			.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" });
		const { lifecycle } = browserContext({ fetch });
		await lifecycle.mutate("headers", "/api/headers", {
			headers: new Headers({ "X-First": "one" }),
		});
		await lifecycle.mutate("tuples", "/api/tuples", {
			headers: [["X-Second", "two"], ["authorization", "Bearer wrong"]],
		});
		const first = fetch.mock.calls[0]![1].headers as Headers;
		const second = fetch.mock.calls[1]![1].headers as Headers;
		expect(first.get("X-First")).toBe("one");
		expect(first.get("Authorization")).toBe("Bearer secret");
		expect(second.get("X-Second")).toBe("two");
		expect(second.get("Authorization")).toBe("Bearer secret");
	});

	it("normalizes network and JSON decoding failures", async () => {
		const fetch = vi.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => { throw new SyntaxError("bad json"); },
			})
			.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" });
		const { lifecycle } = browserContext({ fetch });
		await expect(lifecycle.mutate("network", "/api/network")).rejects.toMatchObject({
			name: "DashboardRequestError",
			kind: "network",
			message: "offline",
		});
		await expect(lifecycle.mutate("decode", "/api/decode")).rejects.toMatchObject({
			name: "DashboardRequestError",
			kind: "decode",
			message: "bad json",
		});
		await expect(lifecycle.mutate("network", "/api/network")).resolves.toBeNull();
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("delivers only the latest read in a named stream while independent streams continue", async () => {
		const first = deferred<any>();
		const second = deferred<any>();
		const independent = deferred<any>();
		const fetch = vi.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise)
			.mockReturnValueOnce(independent.promise);
		const { lifecycle } = browserContext({ fetch });
		const events: string[] = [];

		lifecycle.read("detail", "/api/records/1", {
			success: () => events.push("first success"),
			failure: () => events.push("first failure"),
		});
		lifecycle.read("detail", "/api/records/2", {
			success: (value: any) => events.push(value.name),
			failure: () => events.push("second failure"),
		});
		lifecycle.read("summary", "/api/summary", {
			success: (value: any) => events.push(value.name),
			failure: () => events.push("summary failure"),
		});

		expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
		expect(fetch.mock.calls[1]![1].signal.aborted).toBe(false);
		expect(fetch.mock.calls[2]![1].signal.aborted).toBe(false);
		first.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({ name: "stale" }) });
		second.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({ name: "second" }) });
		independent.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({ name: "summary" }) });
		await flush();
		expect(events).toEqual(["second", "summary"]);
	});

	it("cancels a read without delivering a callback", async () => {
		const pending = deferred<any>();
		const fetch = vi.fn().mockReturnValue(pending.promise);
		const { lifecycle } = browserContext({ fetch });
		const callback = vi.fn();
		lifecycle.read("detail", "/api/records/1", { success: callback, failure: callback });
		lifecycle.cancel("detail");
		expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
		pending.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });
		await flush();
		expect(callback).not.toHaveBeenCalled();
	});

	it("coalesces mutations with the same name until the request settles", async () => {
		const pending = deferred<any>();
		const fetch = vi.fn()
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" });
		const { lifecycle } = browserContext({ fetch });
		const first = lifecycle.mutate("refresh", "/api/refresh", { method: "POST" });
		const second = lifecycle.mutate("refresh", "/api/refresh", { method: "POST" });
		expect(second).toBe(first);
		expect(fetch).toHaveBeenCalledTimes(1);
		pending.resolve({ ok: true, status: 204, statusText: "No Content" });
		await expect(first).resolves.toBeNull();
		await expect(lifecycle.mutate("refresh", "/api/refresh", { method: "POST" })).resolves.toBeNull();
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
