import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import safetyPermissions from "./index.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	while (tempDirectories.length > 0) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

function createHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-safety-status-"));
	tempDirectories.push(cwd);
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const setStatus = vi.fn();
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
		registerCommand: vi.fn(),
		registerEntryRenderer: vi.fn(),
	};
	const ctx = {
		cwd,
		hasUI: true,
		ui: { setStatus, notify: vi.fn() },
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		},
	};

	safetyPermissions(pi as any);
	return { ctx, handlers, setStatus };
}

describe("safety permission status", () => {
	it("publishes only the permission mode, not a profile-qualified label", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

		expect(harness.setStatus).toHaveBeenCalledWith("approval-mode", "default");
		expect(harness.setStatus).not.toHaveBeenCalledWith("approval-mode", expect.stringContaining(" · "));
		expect(harness.setStatus).not.toHaveBeenCalledWith("profile", expect.anything());
	});
});
