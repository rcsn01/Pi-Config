import { describe, expect, it, vi } from "vitest";
import { checkCodexAuthentication, CODEX_AUTH_CHECK_ENDPOINT } from "./auth-check.ts";
import type { CodexAuthInspection } from "./types.ts";

const ready: CodexAuthInspection = {
	state: "ready",
	path: "/home/user/.codex/auth.json",
	fileFound: true,
	accessTokenPresent: true,
	accountIdPresent: true,
	credential: { accessToken: "TOP_SECRET_TOKEN", accountId: "account-123" },
};

describe("Codex authentication check", () => {
	it("validates the current Codex credential with the quota endpoint", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
		const result = await checkCodexAuthentication({ inspect: async () => ready, fetchImpl });

		expect(result).toMatchObject({ state: "accepted", credentialAccepted: true });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe(CODEX_AUTH_CHECK_ENDPOINT);
		expect(init).toMatchObject({ method: "GET", redirect: "error" });
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer TOP_SECRET_TOKEN");
		expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account-123");
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
	});

	it("does not make a request when the local auth file is not ready", async () => {
		const fetchImpl = vi.fn();
		const result = await checkCodexAuthentication({
			inspect: async () => ({
				state: "missing", path: "/missing", fileFound: false,
				accessTokenPresent: false, accountIdPresent: false, message: "Run `codex login`.",
			}),
			fetchImpl,
		});
		expect(result).toMatchObject({ state: "missing", credentialAccepted: false });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([401, 403])("returns an actionable rejection for HTTP %s", async (status) => {
		const result = await checkCodexAuthentication({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status })),
		});
		expect(result).toMatchObject({ state: "rejected", statusCode: status, credentialAccepted: false });
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
		expect((result as any).message).toContain("codex login");
	});

	it("sanitizes network and unexpected HTTP failures", async () => {
		const network = await checkCodexAuthentication({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => { throw new Error("request with TOP_SECRET_TOKEN failed"); }),
		});
		expect(network).toMatchObject({ state: "unavailable" });
		expect(JSON.stringify(network)).not.toContain("TOP_SECRET_TOKEN");

		const server = await checkCodexAuthentication({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status: 503 })),
		});
		expect(server).toMatchObject({ state: "unavailable", statusCode: 503 });
		expect(JSON.stringify(server)).not.toContain("SECRET BODY");
	});
});
