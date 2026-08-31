import type { IncomingMessage, ServerResponse } from "node:http";
import { createDashboardServer, type DashboardServer } from "../_shared/dashboard-server.ts";
import { TELEMETRY_USAGE_PAGE } from "./page.ts";
import type { TelemetryUsageState } from "./payload.ts";

export type TelemetryUsageServer = DashboardServer;

interface TelemetryUsageSource {
	getState(): TelemetryUsageState;
	refresh(): Promise<void>;
}

export function createTelemetryUsageServer(source: TelemetryUsageSource): TelemetryUsageServer {
	return createDashboardServer({
		page: TELEMETRY_USAGE_PAGE,
		serverName: "telemetry usage",
		handleApi(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
			if (url.pathname === "/api/usage" && request.method === "GET") {
				response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
					.end(JSON.stringify(source.getState()));
				return true;
			}
			if (url.pathname === "/api/refresh" && request.method === "POST") {
				void source.refresh();
				response.writeHead(202, { "Content-Type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ accepted: true }));
				return true;
			}
			return false;
		},
	});
}