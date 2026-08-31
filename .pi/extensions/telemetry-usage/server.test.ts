import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createTelemetryUsageServer } from "./server.ts";

function requestWithHost(port: string, token: string, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const outgoing = request({
			hostname: "127.0.0.1",
			port,
			path: "/api/usage",
			headers: { Host: host, Authorization: `Bearer ${token}` },
		}, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
}

describe("telemetry usage loopback server", () => {
	it("enforces capability, host, methods, headers, refresh, and shutdown", async () => {
		const source = {
			getState: () => ({ phase: "ready" as const, data: { scannedAt: 1, sessionCount: 0 } as any }),
			refresh: vi.fn(async () => {}),
		};
		const server = createTelemetryUsageServer(source);
		const first = await server.start();
		const second = await server.start();
		expect(second).toEqual(first);
		const parsed = new URL(first.url);
		const token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		const base = `http://127.0.0.1:${parsed.port}`;

		const page = await fetch(base + "/");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		expect(page.headers.get("x-content-type-options")).toBe("nosniff");
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		expect(page.headers.get("access-control-allow-origin")).toBeNull();
		expect(await page.text()).not.toContain(token);

		expect((await fetch(base + "/api/usage")).status).toBe(401);
		expect((await fetch(base + "/api/usage", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
		const headers = { Authorization: `Bearer ${token}` };
		const usage = await fetch(base + "/api/usage", { headers });
		expect(usage.status).toBe(200);
		expect(await usage.json()).toMatchObject({ phase: "ready", data: { scannedAt: 1 } });
		const refresh = await fetch(base + "/api/refresh", { method: "POST", headers });
		expect(refresh.status).toBe(202);
		expect(await refresh.json()).toEqual({ accepted: true });
		expect(source.refresh).toHaveBeenCalledOnce();
		expect((await fetch(base + "/api/usage", { method: "POST", headers })).status).toBe(405);
		expect((await fetch(base + "/missing", { headers })).status).toBe(405);
		expect(await requestWithHost(parsed.port, token, "evil.example")).toBe(403);

		await server.close();
		await expect(fetch(base + "/api/usage", { headers })).rejects.toThrow();
	});
});
