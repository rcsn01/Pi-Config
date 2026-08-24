import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanWorkspace, isSameDevice } from "./plan-workspace.ts";

function describeTree(root: string, relPath = ""): string[] {
	const entries: string[] = [];
	for (const name of readdirSync(join(root, relPath)).sort()) {
		const childRel = relPath === "" ? name : join(relPath, name);
		const child = join(root, childRel);
		const info = lstatSync(child);
		const mode = (info.mode & 0o7777).toString(8);
		if (info.isSymbolicLink()) entries.push(`${childRel}|link|${mode}|${readlinkSync(child)}`);
		else if (info.isDirectory()) {
			entries.push(`${childRel}|dir|${mode}`);
			entries.push(...describeTree(root, childRel));
		} else entries.push(`${childRel}|file|${mode}|${readFileSync(child).toString("hex")}`);
	}
	return entries;
}

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

	it("links node_modules directories at any depth instead of copying them", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		mkdirSync(join(hostRoot, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(hostRoot, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
		mkdirSync(join(hostRoot, "packages", "demo", "node_modules"), { recursive: true });
		writeFileSync(join(hostRoot, "packages", "demo", "node_modules", "nested.txt"), "nested\n");
		writeFileSync(join(hostRoot, "packages", "demo", "index.ts"), "export {};\n");
		const workspace = await createPlanWorkspace(hostRoot);
		try {
			const linked = join(workspace.sandboxRoot, "node_modules");
			const nestedLinked = join(workspace.sandboxRoot, "packages", "demo", "node_modules");
			expect(lstatSync(linked).isSymbolicLink()).toBe(true);
			expect(lstatSync(nestedLinked).isSymbolicLink()).toBe(true);
			expect(readlinkSync(linked)).toBe(realpathSync(join(hostRoot, "node_modules")));
			expect(readlinkSync(nestedLinked)).toBe(realpathSync(join(hostRoot, "packages", "demo", "node_modules")));
			// Reads through the link see host content.
			expect(readFileSync(join(linked, "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
			expect(readFileSync(join(nestedLinked, "nested.txt"), "utf8")).toBe("nested\n");
			// Non-linked content is still an isolated copy.
			expect(lstatSync(join(workspace.sandboxRoot, "packages", "demo", "index.ts")).isFile()).toBe(true);
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("copies directories when shouldLink is overridden", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		mkdirSync(join(hostRoot, "node_modules"));
		writeFileSync(join(hostRoot, "node_modules", "dep.txt"), "dep\n");
		const workspace = await createPlanWorkspace(hostRoot, { shouldLink: () => false });
		try {
			const copied = join(workspace.sandboxRoot, "node_modules");
			expect(lstatSync(copied).isSymbolicLink()).toBe(false);
			expect(lstatSync(copied).isDirectory()).toBe(true);
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("never links the workspace root, even when it is named node_modules", async () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		const hostRoot = join(parent, "node_modules");
		mkdirSync(hostRoot);
		writeFileSync(join(hostRoot, "root.txt"), "root\n");
		const workspace = await createPlanWorkspace(hostRoot);
		try {
			expect(lstatSync(workspace.sandboxRoot).isSymbolicLink()).toBe(false);
			expect(readFileSync(join(workspace.sandboxRoot, "root.txt"), "utf8")).toBe("root\n");
		} finally {
			await workspace.dispose();
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("omits directories matched by shouldExclude", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		mkdirSync(join(hostRoot, ".pi", "worktrees", "feature-x"), { recursive: true });
		writeFileSync(join(hostRoot, ".pi", "worktrees", "feature-x", "index.ts"), "export {};\n");
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		const workspace = await createPlanWorkspace(hostRoot, {
			shouldExclude: (relPath) => relPath === join(".pi", "worktrees"),
		});
		try {
			expect(existsSync(join(workspace.sandboxRoot, ".pi", "worktrees"))).toBe(false);
			expect(readFileSync(join(workspace.sandboxRoot, "tracked.txt"), "utf8")).toBe("host\n");
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("dispose removes links without touching their host targets", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		mkdirSync(join(hostRoot, "node_modules"));
		writeFileSync(join(hostRoot, "node_modules", "keep.txt"), "keep\n");
		const workspace = await createPlanWorkspace(hostRoot);
		const planRoot = workspace.root;
		await workspace.dispose();
		try {
			expect(existsSync(planRoot)).toBe(false);
			expect(readFileSync(join(hostRoot, "node_modules", "keep.txt"), "utf8")).toBe("keep\n");
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("selects junction links on win32", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		mkdirSync(join(hostRoot, "node_modules"));
		const workspace = await createPlanWorkspace(hostRoot, { platform: "win32" });
		try {
			// On POSIX the symlink type argument is ignored; this exercises the branch.
			expect(lstatSync(join(workspace.sandboxRoot, "node_modules")).isSymbolicLink()).toBe(true);
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("keeps large host files independent with either copy strategy", async () => {
		for (const cloning of [false, true]) {
			const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
			const original = Buffer.alloc(4 * 1024 * 1024, 0x61);
			writeFileSync(join(hostRoot, "large.bin"), original);
			const workspace = await createPlanWorkspace(hostRoot, { supportsCloning: async () => cloning });
			try {
				writeFileSync(join(workspace.sandboxRoot, "large.bin"), Buffer.alloc(original.length, 0x62));
				expect(readFileSync(join(hostRoot, "large.bin")).equals(original)).toBe(true);
			} finally {
				await workspace.dispose();
				rmSync(hostRoot, { recursive: true, force: true });
			}
		}
	}, 20_000);

	it("produces equivalent trees with clone and fs.cp strategies", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		const externalRoot = mkdtempSync(join(tmpdir(), "pi-plan-external-"));
		mkdirSync(join(hostRoot, "nested", "node_modules"), { recursive: true });
		mkdirSync(join(hostRoot, "nested", "kept"), { recursive: true });
		mkdirSync(join(hostRoot, "excluded"));
		writeFileSync(join(hostRoot, "root.txt"), "root\n");
		writeFileSync(join(hostRoot, "-odd-name"), "odd\n");
		writeFileSync(join(hostRoot, "nested", "kept", "script.sh"), "#!/bin/sh\n");
		writeFileSync(join(hostRoot, "nested", "node_modules", "dep.js"), "dep\n");
		writeFileSync(join(hostRoot, "excluded", "ignored.txt"), "ignored\n");
		writeFileSync(join(externalRoot, "outside.txt"), "outside\n");
		chmodSync(join(hostRoot, "nested"), 0o750);
		chmodSync(join(hostRoot, "nested", "kept", "script.sh"), 0o751);
		symlinkSync(join(externalRoot, "outside.txt"), join(hostRoot, "nested", "outside-link"));
		const options = { shouldExclude: (relPath: string) => relPath === "excluded" };
		const fallback = await createPlanWorkspace(hostRoot, { ...options, supportsCloning: async () => false });
		const cloned = await createPlanWorkspace(hostRoot, { ...options, supportsCloning: async () => true });
		try {
			expect(describeTree(cloned.sandboxRoot)).toEqual(describeTree(fallback.sandboxRoot));
		} finally {
			await cloned.dispose();
			await fallback.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
			rmSync(externalRoot, { recursive: true, force: true });
		}
	});

	it("falls back after clone command failure and removes partial output", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		const workspace = await createPlanWorkspace(hostRoot, {
			supportsCloning: async () => true,
			runCloneCommand: async (args) => {
				const destination = args.at(-1)!;
				mkdirSync(destination, { recursive: true });
				writeFileSync(join(destination, "partial.txt"), "partial\n");
				throw new Error("clone unavailable");
			},
		});
		try {
			expect(readFileSync(join(workspace.sandboxRoot, "tracked.txt"), "utf8")).toBe("host\n");
			expect(existsSync(join(workspace.sandboxRoot, "partial.txt"))).toBe(false);
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("compares device ids for clone capability checks", () => {
		expect(isSameDevice({ dev: 7 }, { dev: 7 })).toBe(true);
		expect(isSameDevice({ dev: 7 }, { dev: 8 })).toBe(false);
	});

	it("aborts a clone and removes its partial disposable root", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("pi-plan-workspace-")));
		const controller = new AbortController();
		let cloneStarted!: () => void;
		const started = new Promise<void>((resolvePromise) => { cloneStarted = resolvePromise; });
		const creating = createPlanWorkspace(hostRoot, {
			signal: controller.signal,
			supportsCloning: async () => true,
			runCloneCommand: async (args, signal) => {
				const destination = args.at(-1)!;
				mkdirSync(destination, { recursive: true });
				writeFileSync(join(destination, "partial.txt"), "partial\n");
				cloneStarted();
				await new Promise<void>((_resolvePromise, rejectPromise) => {
					signal?.addEventListener("abort", () => rejectPromise(new Error("killed")), { once: true });
				});
			},
		});
		await started;
		controller.abort();

		await expect(creating).rejects.toMatchObject({ name: "AbortError" });
		const after = readdirSync(tmpdir()).filter((name) => name.startsWith("pi-plan-workspace-"));
		expect(after.filter((name) => !before.has(name))).toEqual([]);
		rmSync(hostRoot, { recursive: true, force: true });
	});
});
