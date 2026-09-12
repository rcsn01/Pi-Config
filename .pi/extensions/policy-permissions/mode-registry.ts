/**
 * Permission-mode registry: the single home of the approval-mode vocabulary.
 * Owns the ApprovalMode union and canonical order, /permissions aliases and
 * input resolution, persisted-mode validation, per-mode status labels, picker
 * descriptions, request-local markers, approval disposition, and the full-access
 * switch confirmation. Pure and in-process: no I/O, no clock, no host context at
 * this seam. Prose composition stays adapter-side.
 */

export type ApprovalMode = "read-only" | "default" | "auto-review" | "full-access";

/** Canonical order: picker rows, prose lists, and validation derive from this. */
export const APPROVAL_MODES: readonly ApprovalMode[] = [
	"read-only",
	"default",
	"auto-review",
	"full-access",
];

/** Exact canonical match only — no aliases, no case folding. For persisted values. */
export function isApprovalMode(value: unknown): value is ApprovalMode {
	return APPROVAL_MODES.includes(value as ApprovalMode);
}

export type ModeResolution = { ok: true; mode: ApprovalMode } | { ok: false };

/** Trim + lowercase, then aliases (`auto, full, ro, review`) and canonical ids. Total. */
export function resolveModeInput(raw: string): ModeResolution {
	const input = raw.trim().toLowerCase();
	if (!input) return { ok: false };
	// Aliases before canonical ids (moot today: no alias equals an id).
	const aliased = ALIASES.get(input);
	if (aliased) return { ok: true, mode: aliased };
	if (isApprovalMode(input)) return { ok: true, mode: input };
	return { ok: false };
}

/**
 * Per-mode approval disposition resolved against the in-memory hasUI fact.
 * read-only            → decided { allowed: false, reason: "Read-only mode." }
 * default + no UI      → decided { allowed: false, reason: "No UI available for approval." }
 * default + UI         → prompt
 * auto-review/full-access → decided { allowed: true }
 * The prompt outcome is reachable only for default mode with a UI.
 */
export type ApprovalDisposition =
	| { kind: "decided"; result: { allowed: boolean; reason?: string } }
	| { kind: "prompt" };

export function approvalDisposition(mode: ApprovalMode, hasUI: boolean): ApprovalDisposition {
	const approval = MODE_FACTS[mode].approval;
	if (approval.kind === "deny") {
		return { kind: "decided", result: { allowed: false, reason: approval.reason } };
	}
	if (approval.kind === "allow") return { kind: "decided", result: { allowed: true } };
	return hasUI
		? { kind: "prompt" }
		: { kind: "decided", result: { allowed: false, reason: approval.unavailableReason } };
}

/** Bare status-line label ("read-only" …) — identity today, single home for divergence. */
export function modeStatusLabel(mode: ApprovalMode): string {
	return MODE_FACTS[mode].statusLabel;
}

/** Long /permissions picker description. */
export function modePickerDescription(mode: ApprovalMode): string {
	return MODE_FACTS[mode].pickerDescription;
}

/**
 * Minimal request-local marker. Only read-only is disclosed to the agent.
 */
export function modeRequestMarker(mode: ApprovalMode): string | undefined {
	return MODE_FACTS[mode].requestMarker;
}

/** Confirmation required before switching INTO a mode; undefined = switch directly. */
export interface ModeSwitchConfirmation {
	title: string;
	message: string;
}

export function modeSwitchConfirmation(mode: ApprovalMode): ModeSwitchConfirmation | undefined {
	return MODE_FACTS[mode].switchConfirmation;
}

// ── Private vocabulary table ───────────────────────────────────────────

/**
 * `Record<ApprovalMode, ModeFacts>` makes a mode without its facts a compile
 * error — the exhaustiveness machinery is implementation, not interface.
 * Every field has exactly one consumer today; do not add a field without one.
 */
interface ModeFacts {
	aliases: readonly string[];
	statusLabel: string;
	pickerDescription: string;
	requestMarker?: string;
	approval:
		| { kind: "deny"; reason: string }
		| { kind: "allow" }
		| { kind: "prompt"; unavailableReason: string };
	switchConfirmation?: ModeSwitchConfirmation;
}

const MODE_FACTS: Record<ApprovalMode, ModeFacts> = {
	"read-only": {
		aliases: ["ro"],
		statusLabel: "read-only",
		pickerDescription: "Read-only browsing – read in current directory only",
		requestMarker: "Read-only",
		approval: { kind: "deny", reason: "Read-only mode." },
	},
	default: {
		// "auto" historically resolved to default, not auto-review — a pinned
		// quirk; changing it would be a behavior change.
		aliases: ["auto"],
		statusLabel: "default",
		pickerDescription: "Default – read, edit, and run commands in workspace; approval for internet and external writes",
		approval: { kind: "prompt", unavailableReason: "No UI available for approval." },
	},
	"auto-review": {
		aliases: ["review"],
		statusLabel: "auto-review",
		pickerDescription: "Auto-review – full auto; only prompts you for edits outside the workspace",
		approval: { kind: "allow" },
	},
	"full-access": {
		aliases: ["full"],
		statusLabel: "full-access",
		pickerDescription: "Full Access – no restrictions, no approval prompts (use with caution)",
		approval: { kind: "allow" },
		switchConfirmation: {
			title: "⚠️ Full Access Mode",
			message: "This removes ALL restrictions. The agent can run any command, write anywhere, and access the network without confirmation.\n\nExercise caution when using.\n\nAre you sure?",
		},
	},
};

/** Alias table derived from the facts; aliases win over canonical ids (moot today). */
const ALIASES: ReadonlyMap<string, ApprovalMode> = new Map(
	APPROVAL_MODES.flatMap((mode) => MODE_FACTS[mode].aliases.map((alias) => [alias, mode] as const)),
);