import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import keybindingsExtension, { ensureThinkingCycleBinding } from "./index.ts";

let testAgentDir = "";
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
	testAgentDir = mkdtempSync(join(tmpdir(), "config-keybindings-agent-"));
	process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

afterAll(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	rmSync(testAgentDir, { recursive: true, force: true });
});

describe("keybinding provisioning", () => {
	it("creates the config directory and required binding when missing", () => {
		const root = mkdtempSync(join(tmpdir(), "config-keybindings-config-"));
		const configPath = join(root, "nested", "keybindings.json");

		try {
			ensureThinkingCycleBinding(configPath);

			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
				"app.thinking.cycle": [],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves unrelated keybindings while adding the required binding", () => {
		const root = mkdtempSync(join(tmpdir(), "config-keybindings-config-"));
		const configPath = join(root, "keybindings.json");
		writeFileSync(configPath, JSON.stringify({ "app.model.select": "ctrl+l" }, null, 2) + "\n");

		try {
			ensureThinkingCycleBinding(configPath);

			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
				"app.model.select": "ctrl+l",
				"app.thinking.cycle": [],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("replaces a conflicting thinking-cycle binding", () => {
		const root = mkdtempSync(join(tmpdir(), "config-keybindings-config-"));
		const configPath = join(root, "keybindings.json");
		writeFileSync(configPath, JSON.stringify({
			"app.thinking.cycle": ["shift+tab"],
			"app.model.select": "ctrl+l",
		}, null, 2) + "\n");

		try {
			ensureThinkingCycleBinding(configPath);

			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
				"app.thinking.cycle": [],
				"app.model.select": "ctrl+l",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not rewrite an already-correct config", () => {
		const root = mkdtempSync(join(tmpdir(), "config-keybindings-config-"));
		const configPath = join(root, "keybindings.json");
		const original = '{\n  "app.thinking.cycle": []\n}\n';
		writeFileSync(configPath, original);

		try {
			ensureThinkingCycleBinding(configPath);
			ensureThinkingCycleBinding(configPath);

			expect(readFileSync(configPath, "utf8")).toBe(original);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves malformed JSON unchanged and warns", () => {
		const root = mkdtempSync(join(tmpdir(), "config-keybindings-config-"));
		const configPath = join(root, "keybindings.json");
		const malformed = "{ not valid json";
		writeFileSync(configPath, malformed);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			ensureThinkingCycleBinding(configPath);

			expect(readFileSync(configPath, "utf8")).toBe(malformed);
			expect(warning).toHaveBeenCalledOnce();
		} finally {
			warning.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses Pi's configured agent directory when the extension loads", () => {
		const configPath = join(testAgentDir, "keybindings.json");
		rmSync(configPath, { force: true });

		keybindingsExtension({ on: vi.fn() } as any);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			"app.thinking.cycle": [],
		});
	});
});
