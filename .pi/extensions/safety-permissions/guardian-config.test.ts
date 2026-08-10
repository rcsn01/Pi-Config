import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGuardianDefinition, resolveGuardianPath } from "./index.ts";

describe("guardian configuration", () => {
	it("resolves the colocated guardian file from an encoded module URL", () => {
		const modulePath = path.join(process.cwd(), "directory with spaces", "index.ts");

		expect(resolveGuardianPath(pathToFileURL(modulePath).href)).toBe(
			path.join(path.dirname(modulePath), "guardian.md"),
		);
	});

	it("parses CRLF frontmatter and the guardian system prompt", () => {
		const definition = parseGuardianDefinition(
			"---\r\nname: guardian\r\nmodel: test/model\r\ntools:\r\n---\r\n\r\nReview this action.\r\n",
		);

		expect(definition).toEqual({
			systemPrompt: "Review this action.",
			model: "test/model",
			tools: "",
		});
	});
});
