import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PlaneClient } from "./client.ts"
import { PlaneApiError } from "./errors.ts"

describe("PlaneClient", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	it("builds workspace-scoped URLs", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			text: async () => JSON.stringify({ results: [] }),
		})
		vi.stubGlobal("fetch", fetchMock)

		const client = new PlaneClient({
			baseUrl: "https://plane.example.com",
			workspaceSlug: "acme",
			apiKey: "key",
		})
		await client.request("GET", "/projects/")

		expect(fetchMock).toHaveBeenCalledWith(
			"https://plane.example.com/api/v1/workspaces/acme/projects/",
			expect.objectContaining({
				headers: expect.objectContaining({ "X-API-Key": "key" }),
			}),
		)
	})

	it("retries once on 429", async () => {
		let calls = 0
		const fetchMock = vi.fn().mockImplementation(async () => {
			calls += 1
			if (calls === 1) {
				return { ok: false, status: 429, text: async () => "rate limited" }
			}
			return { ok: true, status: 200, text: async () => '{"id":"1"}' }
		})
		vi.stubGlobal("fetch", fetchMock)

		const client = new PlaneClient({
			baseUrl: "https://api.plane.so",
			workspaceSlug: "ws",
			apiKey: "k",
		})
		const promise = client.request("GET", "/projects/")
		await vi.advanceTimersByTimeAsync(30_000)
		const result = await promise

		expect(result).toEqual({ id: "1" })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("throws PlaneApiError on failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 403,
				text: async () => "forbidden",
			}),
		)
		const client = new PlaneClient({
			baseUrl: "https://api.plane.so",
			workspaceSlug: "ws",
			apiKey: "k",
		})
		await expect(client.request("GET", "/projects/")).rejects.toBeInstanceOf(PlaneApiError)
	})
})
