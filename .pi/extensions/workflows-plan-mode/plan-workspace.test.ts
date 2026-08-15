import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanWorkspace } from "./plan-workspace.ts";

describe("createPlanWorkspace", () => {
	it("provides a disposable copy without linking mutable host files", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		const workspace = await createPlanWorkspace(hostRoot);
		try {
			expect(readFileSync(join(workspace.sandboxRoot, "tracked.txt"), "utf8")).toBe("host\n");
			writeFileSync(join(workspace.sandboxRoot, "tracked.txt"), "sandbox\n");
			writeFileSync(join(workspace.sandboxRoot, "artifact.txt"), "generated\n");

			expect(readFileSync(join(hostRoot, "tracked.txt"), "utf8")).toBe("host\n");
			expect(existsSync(join(hostRoot, "artifact.txt"))).toBe(false);
		} finally {
			const planRoot = workspace.root;
			await workspace.dispose();
			expect(existsSync(planRoot)).toBe(false);
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("preserves symlinks instead of copying external targets", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		const externalRoot = mkdtempSync(join(tmpdir(), "pi-plan-external-"));
		writeFileSync(join(externalRoot, "outside.txt"), "outside\n");
		symlinkSync(join(externalRoot, "outside.txt"), join(hostRoot, "outside-link"));
		const workspace = await createPlanWorkspace(hostRoot);
		try {
			expect(lstatSync(join(workspace.sandboxRoot, "outside-link")).isSymbolicLink()).toBe(true);
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
			rmSync(externalRoot, { recursive: true, force: true });
		}
	});
});
