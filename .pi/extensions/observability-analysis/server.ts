import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { ANALYSIS_PAGE } from "./page.ts";
import type { AnalysisRecord, AnalysisSummary } from "./runtime.ts";

export interface AnalysisServer {
	start(): Promise<{ url: string }>;
	close(): Promise<void>;
}

interface AnalysisSource {
	getSummary(): AnalysisSummary;
	getRecord(sequence: number): AnalysisRecord | undefined;
	clear(): void;
}

const SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
};

function authorized(header: string | undefined, capability: string): boolean {
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) return false;
	const supplied = Buffer.from(header.slice(prefix.length), "utf8");
	const expected = Buffer.from(capability, "utf8");
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isLoopback(address: string | undefined): boolean {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function createAnalysisServer(source: AnalysisSource): AnalysisServer {
	let server: Server | undefined;
	let capability: string | undefined;
	let port: number | undefined;
	const sockets = new Set<Socket>();

	return {
		start() {
			if (server && capability && port) return Promise.resolve({ url: `http://localhost:${port}/#token=${capability}` });
			capability = randomBytes(32).toString("hex");
			return new Promise((resolve, reject) => {
				const current = createServer((request, response) => {
					for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
					const expectedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
					if (!isLoopback(request.socket.remoteAddress) || !request.headers.host || !expectedHosts.has(request.headers.host)) {
						response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Forbidden");
						return;
					}
					const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
					if (url.pathname === "/" && request.method === "GET") {
						response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(ANALYSIS_PAGE);
						return;
					}
					if (!authorized(request.headers.authorization, capability!)) {
						response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "WWW-Authenticate": "Bearer" }).end("Unauthorized");
						return;
					}
					if (url.pathname === "/api/summary" && request.method === "GET") {
						response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(source.getSummary()));
						return;
					}
					const match = url.pathname.match(/^\/api\/records\/(\d+)$/);
					if (match && request.method === "GET") {
						const record = source.getRecord(Number(match[1]));
						if (!record) {
							response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
							return;
						}
						response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(record));
						return;
					}
					if (url.pathname === "/api/clear" && request.method === "POST") {
						source.clear();
						response.writeHead(204).end();
						return;
					}
					response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, POST" }).end("Method not allowed");
				});
				server = current;
				current.on("connection", (socket) => {
					sockets.add(socket);
					socket.on("close", () => sockets.delete(socket));
				});
				current.once("error", (error) => {
					server = undefined;
					capability = undefined;
					reject(error);
				});
				current.listen(0, "127.0.0.1", () => {
					const address = current.address();
					if (!address || typeof address === "string") return reject(new Error("Could not determine analysis server port."));
					port = address.port;
					resolve({ url: `http://localhost:${port}/#token=${capability}` });
				});
			});
		},
		async close() {
			const current = server;
			server = undefined;
			capability = undefined;
			port = undefined;
			if (!current) return;
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
		},
	};
}
