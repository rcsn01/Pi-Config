import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export default function childObservationExtension(pi: ExtensionAPI): void {
	const fd = Number(process.env.PI_CHILD_OBSERVATION_FD);
	if (!Number.isInteger(fd) || fd < 3) return;
	let writable = true;
	const relay = (event: Record<string, unknown>) => {
		if (!writable) return;
		try {
			const frame = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
			if (frame.length > MAX_FRAME_BYTES) return;
			let offset = 0;
			while (offset < frame.length) {
				const written = fs.writeSync(fd, frame, offset, frame.length - offset);
				if (written <= 0) throw new Error("child observation pipe closed");
				offset += written;
			}
		} catch {
			writable = false;
		}
	};

	pi.on("agent_start", () => relay({ type: "agent_start" }));
	pi.on("turn_start", (event) => relay({ type: "turn_start", turnIndex: event.turnIndex, at: event.timestamp }));
	pi.on("before_provider_request", (event, ctx) => {
		if (!ctx.model) return;
		relay({
			type: "request",
			provider: ctx.model.provider,
			api: ctx.model.api,
			model: ctx.model.id,
			payload: event.payload,
		});
	});
	pi.on("after_provider_response", (event) => relay({ type: "response", status: event.status }));
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") relay({ type: "assistant", message: event.message });
	});
}
