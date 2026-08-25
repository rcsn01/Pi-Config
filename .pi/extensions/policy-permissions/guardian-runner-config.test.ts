import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
	const catalogueModel = {
		provider: "test",
		id: "guardian",
		name: "Guardian",
		api: "openai-responses",
		contextWindow: 512_000,
		maxTokens: 4096,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return {
		catalogueModel,
		createAgentSession: vi.fn(async (options: any) => {
			const session: any = {
				model: options.model,
				messages: [],
				dispose: vi.fn(),
				abort: vi.fn(),
				prompt: vi.fn(async () => {
					session.messages.push({
						role: "assistant",
						content: [{ type: "text", text: '{"outcome":"allow","rationale":"safe"}' }],
					});
				}),
			};
			return { session };
		}),
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: mocked.createAgentSession,
	DefaultResourceLoader: class {
		constructor(_options: unknown) {}
		async reload() {}
	},
	getAgentDir: () => "/tmp/pi-agent",
	ModelRuntime: class {
		static async create() {
			return { getModel: (provider: string, id: string) =>
				provider === mocked.catalogueModel.provider && id === mocked.catalogueModel.id
					? mocked.catalogueModel
					: undefined };
		}
	},
	parseFrontmatter: (content: string) => ({ frontmatter: {}, body: content.replace(/^---\n---\n/, "") }),
	SessionManager: { inMemory: () => ({}) },
	SettingsManager: { create: () => ({ getDefaultProvider: () => "test" }) },
}));

vi.mock("../_shared/observability.ts", () => ({
	getObservabilityService: () => ({ isActive: () => false, publish: vi.fn() }),
}));

import { disposeAutoReviewer, runAutoReviewer } from "./guardian-runner.ts";

const roots: string[] = [];
afterEach(async () => {
	await disposeAutoReviewer();
	vi.clearAllMocks();
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Guardian runner profile configuration", () => {
	it("creates the isolated session with the selected model, thinking, and context", async () => {
		const root = mkdtempSync(join(tmpdir(), "guardian-runner-config-"));
		roots.push(root);
		const guardianPath = join(root, "guardian.md");
		writeFileSync(guardianPath, "---\n---\nReview safely.\n");

		const result = await runAutoReviewer(
			"Command Review",
			"Command: example",
			{
				settings: {
					provider: "test",
					modelId: "guardian",
					thinkingLevel: "high",
					contextWindow: 256_000,
				},
			},
			guardianPath,
		);

		expect(result).toMatchObject({ allowed: true, model: "test/guardian" });
		expect(mocked.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
			thinkingLevel: "high",
			model: expect.objectContaining({
				provider: "test",
				id: "guardian",
				contextWindow: 256_000,
			}),
		}));
	});
});
