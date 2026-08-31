import type { Usage } from "@earendil-works/pi-ai";

export type AdvisorResult =
	| {
		readonly ok: true;
		readonly text: string;
		readonly model: string;
		readonly truncated: boolean;
		readonly usage?: Usage;
	}
	| {
		readonly ok: false;
		readonly message: string;
		readonly model: string;
		readonly usage?: Usage;
	};

export interface AdvisorToolDetails {
	model: string;
	truncated: boolean;
}

export interface AdvisorToolResult {
	content: [{ type: "text"; text: string }];
	details: AdvisorToolDetails;
	usage?: Usage;
	isError?: true;
}

export function advisorSuccess(
	text: string,
	model: string,
	usage?: Usage,
	truncated = false,
): AdvisorResult {
	return { ok: true, text, model, truncated, ...(usage ? { usage } : {}) };
}

export function advisorFailure(message: string, model: string, usage?: Usage): AdvisorResult {
	return { ok: false, message, model, ...(usage ? { usage } : {}) };
}

export function toAdvisorToolResult(result: AdvisorResult): AdvisorToolResult {
	if (!result.ok) {
		return {
			content: [{ type: "text", text: result.message }],
			details: { model: result.model, truncated: false },
			...(result.usage ? { usage: result.usage } : {}),
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: result.text }],
		details: { model: result.model, truncated: result.truncated },
		...(result.usage ? { usage: result.usage } : {}),
	};
}

interface PersistedAdvisorResult {
	content?: readonly { type?: string; text?: string }[];
	details?: unknown;
	isError?: boolean;
}

/** Classify current results and older results that encoded failures in text. */
export function classifyAdvisorToolResult(result: PersistedAdvisorResult): "success" | "warning" | "failure" {
	const details = result.details && typeof result.details === "object"
		? result.details as { truncated?: unknown }
		: undefined;
	if (details?.truncated === true) return "warning";
	if (result.isError === true) return "failure";
	const text = result.content
		?.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n") ?? "";
	return text.startsWith("advisor_") ? "failure" : "success";
}
