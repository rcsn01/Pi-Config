import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { createDashboardServer } from "./dashboard-server.ts";

function requestWithHost(port: string, token: string, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const outgoing = request({
			hostname: "127.0.0.1",
			port,
			path: "/api/ping",
			headers: { Host: host, Authorization: `Bearer ${token}` },
		}, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
}

describe("dashboard server factory", () => {
	it("serves the page unauthenticated, gates the API, and handles the 405 fallback", async () => {
		const calls: string[] = [];
		const server = createDashboardServer({
			page: "<html>stub page</html>",
			serverName: "stub",
			handleApi(request, response, url) {
				calls.push(`${request.method} ${url.pathname}`);
				if (url.pathname === "/api/ping" && request.method === "GET") {
					response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end("{}");
					return true;
				}
				if (url.pathname === "/api/gone" && request.method === "GET") {
					response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
					return true;
				}
				return false;
			},
		});
		const first = await server.start();
		const second = await server.start();
		expect(second).toEqual(first);
		const parsed = new URL(first.url);
		const token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		const base = `http://127.0.0.1:${parsed.port}`;
		const headers = { Authorization: `Bearer ${token}` };

		const page = await fetch(base + "/");
		expect(page.status).toBe(200);
		expect(await page.text()).toBe("<html>stub page</html>");
		expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.headers.get("access-control-allow-origin")).toBeNull();

		expect((await fetch(base + "/api/ping")).status).toBe(401);
		expect((await fetch(base + "/api/ping", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
		expect((await fetch(base + "/api/ping", { headers })).status).toBe(200);
		expect((await fetch(base + "/api/gone", { headers })).status).toBe(404);
		const unhandled = await fetch(base + "/other", { headers });
		expect(unhandled.status).toBe(405);
		expect(unhandled.headers.get("allow")).toBe("GET, POST");
		expect(await requestWithHost(parsed.port, token, "evil.example")).toBe(403);

		await server.close();
		await expect(fetch(base + "/api/ping", { headers })).rejects.toThrow();

		const restarted = await server.start();
		expect(new URL(restarted.url).port).not.toBe(parsed.port);
		await server.close();
		expect(calls).toEqual(["GET /api/ping", "GET /api/gone", "GET /other"]);
	});
});