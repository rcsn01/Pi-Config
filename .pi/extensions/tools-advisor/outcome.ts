import type { Usage } from "@earendil-works/pi-ai";
import type { TranscriptProjectionErrorCode } from "./transcript.ts";

type AdvisorProjectionFailureCode = `advisor_${TranscriptProjectionErrorCode}`;

export type AdvisorFailureCode =
	| "advisor_off"
	| "advisor_settings_error"
	| "advisor_budget_exhausted"
	| "advisor_turn_budget_exhausted"
	| "advisor_model_unavailable"
	| "advisor_auth_unavailable"
	| "advisor_provider_unavailable"
	| "advisor_preflight_error"
	| "advisor_context_window_invalid"
	| AdvisorProjectionFailureCode
	| "advisor_context_error"
	| "advisor_aborted"
	| "advisor_provider_error"
	| "advisor_empty";

export type AdvisorOutcome =
	| {
		readonly disposition: "success";
		readonly code: "advisor_ok";
		readonly message: string;
		readonly model: string;
		readonly consumesBudget: true;
		readonly truncated: false;
		readonly usage?: Usage;
	}
	| {
		readonly disposition: "warning";
		readonly code: "advisor_truncated";
		readonly message: string;
		readonly model: string;
		readonly consumesBudget: true;
		readonly truncated: true;
		readonly usage?: Usage;
	}
	| {
		readonly disposition: "failure";
		readonly code: AdvisorFailureCode;
		readonly message: string;
		readonly model: string;
		readonly consumesBudget: boolean;
		readonly truncated: false;
		readonly usage?: Usage;
	};

export interface AdvisorToolDetails {
	model: string;
	consumesBudget: boolean;
	truncated: boolean;
}

export interface AdvisorToolResult {
	content: [{ type: "text"; text: string }];
	details: AdvisorToolDetails;
	usage?: Usage;
	isError?: true;
}

export function advisorSuccess(message: string, model: string, usage?: Usage): AdvisorOutcome {
	return {
		disposition: "success",
		code: "advisor_ok",
		message,
		model,
		consumesBudget: true,
		truncated: false,
		...(usage ? { usage } : {}),
	};
}

export function advisorWarning(message: string, model: string, usage?: Usage): AdvisorOutcome {
	return {
		disposition: "warning",
		code: "advisor_truncated",
		message,
		model,
		consumesBudget: true,
		truncated: true,
		...(usage ? { usage } : {}),
	};
}

export function advisorFailure(
	code: AdvisorFailureCode,
	message: string,
	model: string,
	consumesBudget: boolean,
	usage?: Usage,
): AdvisorOutcome {
	return {
		disposition: "failure",
		code,
		message,
		model,
		consumesBudget,
		truncated: false,
		...(usage ? { usage } : {}),
	};
}

export function toAdvisorToolResult(outcome: AdvisorOutcome): AdvisorToolResult {
	const text = outcome.disposition === "success"
		? outcome.message
		: `${outcome.code}: ${outcome.message}`;
	return {
		content: [{ type: "text", text }],
		details: {
			model: outcome.model,
			consumesBudget: outcome.consumesBudget,
			truncated: outcome.truncated,
		},
		...(outcome.usage ? { usage: outcome.usage } : {}),
		...(outcome.disposition === "failure" ? { isError: true as const } : {}),
	};
}

interface PersistedAdvisorResult {
	content?: readonly { type?: string; text?: string }[];
	details?: unknown;
	isError?: boolean;
}

/** Classify current results and legacy results that encoded failure in text. */
export function classifyAdvisorToolResult(result: PersistedAdvisorResult): AdvisorOutcome["disposition"] {
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
