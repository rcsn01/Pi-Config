/**
 * Saved Prompts Extension - exposes Markdown prompts as /prompt:<name> commands.
 */

import {
	parseFrontmatter,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const DEFAULT_PROMPTS_DIRECTORY = join(import.meta.dirname, "prompts");
const VALID_PROMPT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export interface SavedPrompt {
	readonly name: string;
	readonly description: string;
	readonly content: string;
}

function fallbackDescription(content: string): string {
	const firstLine = content.split("\n").find((line) => line.trim())?.trim() ?? "";
	return firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
}

export function loadSavedPrompts(directory = DEFAULT_PROMPTS_DIRECTORY): SavedPrompt[] {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}

	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.sort((left, right) => left.name.localeCompare(right.name))
		.flatMap((entry) => {
			const name = basename(entry.name, ".md");
			if (!VALID_PROMPT_NAME.test(name)) return [];

			try {
				const { frontmatter, body } = parseFrontmatter(readFileSync(join(directory, entry.name), "utf8"));
				const description = typeof frontmatter.description === "string"
					? frontmatter.description
					: fallbackDescription(body);
				return [{ name, description, content: body }];
			} catch {
				return [];
			}
		});
}

export function createSavedPromptsExtension(prompts: readonly SavedPrompt[] = loadSavedPrompts()) {
	return function savedPromptsExtension(pi: ExtensionAPI): void {
		for (const prompt of prompts) {
			pi.registerCommand(`prompt:${prompt.name}`, {
				description: prompt.description,
				handler: async () => {
					pi.sendUserMessage(prompt.content);
				},
			});
		}
	};
}

export default createSavedPromptsExtension();
