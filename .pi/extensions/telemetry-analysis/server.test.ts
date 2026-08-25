import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { createAnalysisServer } from "./server.ts";

function requestWithHost(port: string, token: string, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const outgoing = request({ hostname: "127.0.0.1", port, path: "/api/summary", headers: { Host: host, Authorization: `Bearer ${token}` } }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
}

function source() {
	return {
		getSummary: () => ({ activatedAt: 1, paused: false, retainedBytes: 0, limits: { recordBytes: 1, totalBytes: 2 }, records: [] }),
		getRecord: (sequence: number) => sequence === 7 ? ({ sequence: 7, requestJson: "{}" }) as any : undefined,
		clear: () => {},
	};
}

describe("analysis loopback server", () => {
	it("enforces capability, host, methods, headers, clear, and shutdown", async () => {
		let clears = 0;
		const data = source();
		data.clear = () => { clears++; };
		const server = createAnalysisServer(data as any);
		const { url } = await server.start();
		const parsed = new URL(url);
		const token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
		const base = `http://127.0.0.1:${parsed.port}`;

		const page = await fetch(base + "/");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.headers.get("access-control-allow-origin")).toBeNull();
		expect(await page.text()).not.toContain(token);

		expect((await fetch(base + "/api/summary")).status).toBe(401);
		const headers = { Authorization: `Bearer ${token}` };
		const summary = await fetch(base + "/api/summary", { headers });
		expect(summary.status).toBe(200);
		expect(await summary.json()).toMatchObject({ activatedAt: 1 });
		expect((await fetch(base + "/api/records/7", { headers })).status).toBe(200);
		expect((await fetch(base + "/api/records/8", { headers })).status).toBe(404);
		expect((await fetch(base + "/api/clear", { method: "POST", headers })).status).toBe(204);
		expect(clears).toBe(1);
		expect((await fetch(base + "/api/summary", { method: "POST", headers })).status).toBe(405);
		expect(await requestWithHost(parsed.port, token, "evil.example")).toBe(403);

		await server.close();
		await expect(fetch(base + "/api/summary", { headers })).rejects.toThrow();
	});
});
