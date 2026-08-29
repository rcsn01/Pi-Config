/**
 * Re-renders the "Guidelines" section that pi's stock buildSystemPrompt()
 * emits, but which is dropped when a custom prompt (SYSTEM.md,
 * --system-prompt) replaces the default build.
 *
 * The "Available tools" list is deliberately NOT re-rendered: tool discovery
 * rides on the provider payload's function schemas, so listing tools in the
 * prompt would duplicate them. Guidelines are prompt-only usage policy (no
 * payload equivalent), so they are restored.
 *
 * Mirrors pi's rendering (dist/core/system-prompt.js) line for line:
 * - the tool-conditional file-operations guideline
 * - per-tool promptGuidelines, trimmed, non-empty, de-duplicated in order
 * - the two always-on guidelines
 *
 * Byte-parity with pi is enforced by the golden tests in sections.test.ts.
 */

export interface GuidelineSource {
	/** Active tools in prompt order. Default mirrors pi: [read, bash, edit, write]. */
	selectedTools?: string[];
	/** Guideline bullets contributed per tool. */
	promptGuidelines?: string[];
}

export const GUIDELINES_SECTION_START = "<tool_guidelines>";
export const GUIDELINES_SECTION_END = "</tool_guidelines>";

const DEFAULT_SELECTED_TOOLS = ["read", "bash", "edit", "write"];
const ALWAYS_ON_GUIDELINES = [
	"Be concise in your responses",
	"Show file paths clearly when working with files",
] as const;

const CWD_LINE_MARKER = "\nCurrent working directory: ";
const SECTION_PATTERN = /\n*<tool_guidelines>[\s\S]*?<\/tool_guidelines>\n*/g;

/** Render the "Guidelines" section for the given options. */
export function buildGuidelines(options: GuidelineSource): string {
	const tools = options.selectedTools ?? DEFAULT_SELECTED_TOOLS;
	const guidelines: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string) => {
		const trimmed = guideline.trim();
		if (trimmed.length === 0 || guidelinesSet.has(trimmed)) return;
		guidelinesSet.add(trimmed);
		guidelines.push(trimmed);
	};
	const has = (name: string) => tools.includes(name);
	if ((has("bash") || has("powershell")) && !has("grep") && !has("find") && !has("ls")) {
		if (has("bash") && has("powershell")) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (has("powershell")) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
	}
	for (const guideline of options.promptGuidelines ?? []) {
		addGuideline(guideline);
	}
	for (const guideline of ALWAYS_ON_GUIDELINES) {
		addGuideline(guideline);
	}
	return ["Guidelines:", ...guidelines.map((guideline) => `- ${guideline}`)].join("\n");
}

/** Remove any previously injected section (idempotency guard for double handler runs). */
export function stripGuidelines(prompt: string): string {
	if (!prompt.includes(GUIDELINES_SECTION_START)) return prompt;
	return prompt.replace(SECTION_PATTERN, "\n");
}

/**
 * Insert the section into a prompt: before the trailing "Current working
 * directory:" line when present (pi's custom-prompt build ends with it),
 * otherwise appended at the end. Stable under repeated application.
 */
export function insertGuidelines(prompt: string, guidelines: string): string {
	const base = stripGuidelines(prompt);
	const block = `${GUIDELINES_SECTION_START}\n${guidelines}\n${GUIDELINES_SECTION_END}`;
	const cwdIndex = base.lastIndexOf(CWD_LINE_MARKER);
	if (cwdIndex === -1) {
		return `${base.replace(/\n+$/, "")}\n\n${block}\n`;
	}
	const before = base.slice(0, cwdIndex).replace(/\n+$/, "");
	return `${before}\n\n${block}\n${base.slice(cwdIndex + 1)}`;
}