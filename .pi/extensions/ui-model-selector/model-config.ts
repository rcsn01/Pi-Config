/**
 * Picker-side model selection helpers for the custom /model selector.
 *
 * Parsing, validation, merging, and the apply path live in
 * `../_shared/model-selection.ts`; this module keeps only the searchable-picker
 * helpers and the startup-open decision.
 */

import type { ModelChoiceLike } from "../_shared/model-selection.ts";

export type { ModelChoiceLike } from "../_shared/model-selection.ts";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2)}M`;
	}
	if (tokens >= 1_000) {
		const thousands = tokens / 1_000;
		return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
	}
	return String(tokens);
}

export function hasExplicitModelArgument(argv: readonly string[]): boolean {
	return argv.some((argument) => argument === "--model" || argument.startsWith("--model="));
}

export function shouldOpenStartupModelSelector(
	reason: SessionStartReason,
	hasConversationHistory: boolean,
	argv: readonly string[],
): boolean {
	if (hasExplicitModelArgument(argv)) return false;
	if (reason === "new") return true;
	return reason === "startup" && !hasConversationHistory;
}

export function findExactModel<T extends ModelChoiceLike>(models: readonly T[], reference: string): T | undefined {
	const normalized = reference.trim().toLowerCase();
	if (!normalized) return undefined;

	const canonical = models.find(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
	);
	if (canonical) return canonical;

	const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

export function filterModels<T extends ModelChoiceLike>(models: readonly T[], query: string): T[] {
	const normalized = query.trim().toLowerCase();
	const terms = normalized.split(/\s+/).filter(Boolean);

	return models
		.map((model) => {
			const canonical = `${model.provider}/${model.id}`.toLowerCase();
			const id = model.id.toLowerCase();
			const name = model.name.toLowerCase();
			const searchText = `${canonical} ${name}`;
			if (!terms.every((term) => searchText.includes(term))) return undefined;

			let score = 100;
			if (!normalized) score = 0;
			else if (canonical === normalized) score = -100;
			else if (id === normalized) score = -90;
			else if (canonical.startsWith(normalized)) score = -70;
			else if (id.startsWith(normalized)) score = -60;
			else if (name.startsWith(normalized)) score = -50;
			else score = terms.reduce((total, term) => total + searchText.indexOf(term), 0);

			return { model, canonical, score };
		})
		.filter((entry): entry is { model: T; canonical: string; score: number } => entry !== undefined)
		.sort((left, right) => left.score - right.score || left.canonical.localeCompare(right.canonical))
		.map((entry) => entry.model);
}
