import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanWorkspace } from "./plan-workspace.ts";

describe("createPlanWorkspace", () => {
	it("provides canonical disposable paths", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		const workspace = await createPlanWorkspace(hostRoot);
		try {
			expect(workspace.root).toBe(realpathSync(workspace.root));
			for (const child of [workspace.sandboxRoot, workspace.tempRoot]) {
				const childPath = relative(workspace.root, child);
				expect(isAbsolute(childPath)).toBe(false);
				expect(childPath.startsWith("..")).toBe(false);
			}
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("cancels copying and removes its partial disposable root", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("pi-plan-workspace-")));
		const controller = new AbortController();
		controller.abort();

		await expect(createPlanWorkspace(hostRoot, { signal: controller.signal }))
			.rejects.toMatchObject({ name: "AbortError" });

		const after = readdirSync(tmpdir()).filter((name) => name.startsWith("pi-plan-workspace-"));
		expect(after.filter((name) => !before.has(name))).toEqual([]);
		rmSync(hostRoot, { recursive: true, force: true });
	});

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
