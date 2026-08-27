import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface DashboardServer {
	start(): Promise<{ url: string }>;
	close(): Promise<void>;
}

export interface DashboardServerOptions {
	page: string;
	serverName: string;
	/** Handle an authenticated API request. Return falsy to fall through to the 405 response. */
	handleApi(request: IncomingMessage, response: ServerResponse, url: URL): boolean | undefined;
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

/**
 * Loopback dashboard server with a secret capability token. Serves `page` at `/`
 * without authentication and delegates every other request to `handleApi` behind
 * a bearer-token gate. Only one page and one API surface per server; keep the
 * route handling in the calling extension.
 */
export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
	let server: Server | undefined;
	let capability: string | undefined;
	let port: number | undefined;
	const sockets = new Set<Socket>();

	return {
		start() {
			if (server && capability && port) {
				return Promise.resolve({ url: `http://localhost:${port}/#token=${capability}` });
			}
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
						response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(options.page);
						return;
					}
					if (!authorized(request.headers.authorization, capability!)) {
						response.writeHead(401, {
							"Content-Type": "text/plain; charset=utf-8",
							"WWW-Authenticate": "Bearer",
						}).end("Unauthorized");
						return;
					}
					if (options.handleApi(request, response, url)) return;
					response.writeHead(405, {
						"Content-Type": "text/plain; charset=utf-8",
						Allow: "GET, POST",
					}).end("Method not allowed");
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
					if (!address || typeof address === "string") {
						reject(new Error(`Could not determine ${options.serverName} server port.`));
						return;
					}
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
			await new Promise<void>((resolve, reject) => {
				current.close((error) => error ? reject(error) : resolve());
			});
		},
	};
}