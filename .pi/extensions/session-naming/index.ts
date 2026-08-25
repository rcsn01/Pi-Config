/**
 * session-auto-name — auto-name sessions from the first user prompt.
 *
 * Every session gets a human-readable name derived from its first user
 * message, instead of the id-style display (the session selector shows
 * `session.name ?? firstMessage`, and the terminal title shows
 * `pi - <name> - <cwd>` — a name replaces the id everywhere).
 *
 * Two triggers, both gated on "only when the session has no name":
 *
 * - `message_start`: the moment the first user prompt is sent the session is
 *   named from it (live — the terminal title updates before the turn ends).
 *   Later user messages never rename.
 * - `session_start`: retroactive naming on resume/reload. If the session is
 *   still unnamed, the name is derived from its *first* user message as
 *   recorded in the session file. For `startup`/`new`/`fork` the entries are
 *   empty and this is a no-op; the first prompt names it via `message_start`.
 *
 * The name is a single line: all whitespace/newlines collapse to single
 * spaces, capped at 61 characters plus a "…" suffix (62 total). No
 * markdown stripping, no prefix. Image-only prompts (no extractable text)
 * leave the session unnamed until a message with text arrives.
 *
 * An existing name is never overwritten — manual `/name <x>` renames and
 * names set by other extensions always win. If the user later clears the
 * name, the next user message names the session again (acceptable, arguably
 * desirable).
 *
 * Uses pi's first-class API only: `pi.setSessionName()` persists a
 * `session_info` entry in the session JSONL and emits
 * `session_info_changed`; `ctx.sessionManager` (read-only) exposes
 * `getSessionName()` and `getEntries()`.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const MAX_NAME_LENGTH = 61; // retained chars before the "…" suffix (62 total)

/**
 * Extract the plain-text portion of a user message's content.
 *
 * Accepts the two shapes `UserMessage.content` can take:
 * - a plain string (used for programmatically sent messages), or
 * - an array of `TextContent | ImageContent` blocks, whose `type === "text"`
 *   parts are joined with spaces.
 *
 * Returns `undefined` when there is nothing extractable (e.g. an
 * image-only prompt or an empty message).
 */
function extractText(message: {
	content?: string | { type: string; text?: string }[];
}): string | undefined {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		const parts = content
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string);
		if (parts.length === 0) return undefined;
		return parts.join(" ");
	}
	return undefined;
}

/**
 * Turn raw prompt text into a display name: collapse all whitespace and
 * newlines to single spaces, trim, and cap at 61 characters plus a "…"
 * suffix (62 total).
 *
 * Returns `undefined` when nothing remains after collapsing (whitespace-only
 * input), so the session is left unnamed instead of cleared.
 */
function makeName(text: string): string | undefined {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length === 0) return undefined;
	if (singleLine.length <= MAX_NAME_LENGTH) return singleLine;
	return `${singleLine.slice(0, MAX_NAME_LENGTH)}…`;
}

/** The name for a session whose first user message has extractable text. */
function nameFromFirstUserMessage(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractText(entry.message);
		if (!text) continue;
		return makeName(text);
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Retroactive naming: a resumed or reloaded session that never got a name
	// is named from its true first user message on the spot.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.sessionManager.getSessionName()) return;
		const name = nameFromFirstUserMessage(ctx);
		if (name) pi.setSessionName(name);
	});

	// Live naming: the moment the first user prompt is sent, name the session
	// from it — before the turn even finishes, the terminal title updates.
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user") return;
		if (ctx.sessionManager.getSessionName()) return;
		const text = extractText(event.message);
		if (!text) return;
		const name = makeName(text);
		if (name) pi.setSessionName(name);
	});
}
