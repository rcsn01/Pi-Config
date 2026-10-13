/**
 * Re-renders the "rules" section that pi's stock buildSystemPrompt() emits,
 * but which is dropped when a custom prompt (SYSTEM.md, --system-prompt)
 * replaces the default build.
 *
 * The "tools" and "docs" sections are deliberately NOT re-rendered: tool
 * discovery rides on the provider payload's function schemas, and the docs
 * block only applies to the stock prompt. Rules are prompt-only usage policy,
 * so they are restored — wrapped in pi's own `<rules>` tag so the model sees
 * the same structure it would get from the stock build.
 *
 * Mirrors pi's rendering (dist/core/system-prompt.js buildRules) line for line:
 * - the tool-conditional file-operations guideline
 * - per-tool toolGuidelines, in selectedTools order
 * - contributed promptGuidelines, trimmed, non-empty, de-duplicated in order
 * - the two always-on guidelines
 *
 * Byte-parity with pi is enforced by the golden tests in sections.test.ts.
 */

export interface GuidelineSource {
	/** Active tools in prompt order. Default mirrors pi: [read, bash, edit, write]. */
	selectedTools?: string[];
	/** Guidelines contributed per tool; rendered in selectedTools order. */
	toolGuidelines?: Record<string, readonly string[]>;
	/** Guideline bullets contributed by the user configuration. */
	promptGuidelines?: string[];
}

export const GUIDELINES_SECTION_START = "<tool_guidelines>";
export const GUIDELINES_SECTION_END = "</tool_guidelines>";

const DEFAULT_SELECTED_TOOLS = ["read", "bash", "edit", "write"];
const ALWAYS_ON_GUIDELINES = [
	"Be concise in your responses",
	"Show file paths clearly when working with files",
] as const;

const CWD_SECTION_MARKER = "\n<cwd>";
const SECTION_PATTERN = /\n*<tool_guidelines>[\s\S]*?<\/tool_guidelines>\n*/g;

/** Render the `<rules>` content for the given options (bullet lines, no wrapper). */
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
	const toolGuidelines = options.toolGuidelines ?? {};
	for (const name of tools) {
		for (const guideline of toolGuidelines[name] ?? []) {
			addGuideline(guideline);
		}
	}
	for (const guideline of options.promptGuidelines ?? []) {
		addGuideline(guideline);
	}
	for (const guideline of ALWAYS_ON_GUIDELINES) {
		addGuideline(guideline);
	}
	return guidelines.map((guideline) => `- ${guideline}`).join("\n");
}

/** Remove any previously injected section (idempotency guard for double handler runs). */
export function stripGuidelines(prompt: string): string {
	if (!prompt.includes(GUIDELINES_SECTION_START)) return prompt;
	return prompt.replace(SECTION_PATTERN, "\n\n");
}

/**
 * Insert the rules section into a prompt: before the trailing `<cwd>` section
 * when present (pi's custom-prompt build ends with it), otherwise appended at
 * the end. Stable under repeated application.
 */
export function insertGuidelines(prompt: string, rules: string): string {
	const base = stripGuidelines(prompt);
	const block = `${GUIDELINES_SECTION_START}\n<rules>\n${rules}\n</rules>\n${GUIDELINES_SECTION_END}`;
	const cwdIndex = base.lastIndexOf(CWD_SECTION_MARKER);
	if (cwdIndex === -1) {
		return `${base.replace(/\n+$/, "")}\n\n${block}\n`;
	}
	const before = base.slice(0, cwdIndex).replace(/\n+$/, "");
	return `${before}\n\n${block}\n\n${base.slice(cwdIndex + 1)}`;
}