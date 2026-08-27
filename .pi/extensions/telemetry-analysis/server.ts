import type { IncomingMessage, ServerResponse } from "node:http";
import { createDashboardServer, type DashboardServer } from "../_shared/dashboard-server.ts";
import { ANALYSIS_PAGE } from "./page.ts";
import type { AnalysisRecord, AnalysisSummary } from "./runtime.ts";

export type AnalysisServer = DashboardServer;

interface AnalysisSource {
	getSummary(): AnalysisSummary;
	getRecord(sequence: number): AnalysisRecord | undefined;
	clear(): void;
}

export function createAnalysisServer(source: AnalysisSource): AnalysisServer {
	return createDashboardServer({
		page: ANALYSIS_PAGE,
		serverName: "analysis",
		handleApi(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
			if (url.pathname === "/api/summary" && request.method === "GET") {
				response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(source.getSummary()));
				return true;
			}
			const match = url.pathname.match(/^\/api\/records\/(\d+)$/);
			if (match && request.method === "GET") {
				const record = source.getRecord(Number(match[1]));
				if (!record) {
					response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
					return true;
				}
				response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(record));
				return true;
			}
			if (url.pathname === "/api/clear" && request.method === "POST") {
				source.clear();
				response.writeHead(204).end();
				return true;
			}
			return false;
		},
	});
}