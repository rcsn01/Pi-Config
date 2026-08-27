import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanWorkspace, isSameDevice, makeTreeRemovable } from "./plan-workspace.ts";

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

describe("makeTreeRemovable", () => {
	it("ignores a directory removed between inspection and permission repair", async () => {
		const missing = Object.assign(new Error("directory disappeared"), { code: "ENOENT" });

		await expect(makeTreeRemovable("/disposable/vanished", {
			lstat: async () => ({
				mode: 0o40555,
				isDirectory: () => true,
				isSymbolicLink: () => false,
			}),
			chmod: async () => { throw missing; },
			readdir: async () => [],
		})).resolves.toBeUndefined();
	});
});

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

	it("keeps the disposable temp directory separate for a workspace named tmp", async () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-plan-host-parent-"));
		const hostRoot = join(parent, "tmp");
		mkdirSync(hostRoot);
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		const workspace = await createPlanWorkspace(hostRoot);
		try {
			expect(workspace.tempRoot).not.toBe(workspace.sandboxRoot);
			expect(readFileSync(join(workspace.sandboxRoot, "tracked.txt"), "utf8")).toBe("host\n");
		} finally {
			await workspace.dispose();
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("cancels before copying and leaves no disposable root", async () => {
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
			expect(readlinkSync(join(workspace.sandboxRoot, "outside-link"))).toBe(join(externalRoot, "outside.txt"));
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
			rmSync(externalRoot, { recursive: true, force: true });
		}
	});

	it("copies dependency, environment, cache, and build directories as writable isolated trees", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		const directories = ["node_modules", ".venv", ".pytest_cache", "target"];
		for (const directory of directories) {
			mkdirSync(join(hostRoot, directory), { recursive: true });
			writeFileSync(join(hostRoot, directory, "state.txt"), "host\n");
		}
		const workspace = await createPlanWorkspace(hostRoot);
		try {
			for (const directory of directories) {
				const copied = join(workspace.sandboxRoot, directory);
				expect(lstatSync(copied).isDirectory()).toBe(true);
				expect(lstatSync(copied).isSymbolicLink()).toBe(false);
				writeFileSync(join(copied, "state.txt"), "sandbox\n");
				expect(readFileSync(join(hostRoot, directory, "state.txt"), "utf8")).toBe("host\n");
			}
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("copies the complete tree including Pi-managed and repository metadata", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		for (const relPath of [join(".pi", "worktrees", "feature"), join(".pi", "repos", "snapshot"), ".git"]) {
			mkdirSync(join(hostRoot, relPath), { recursive: true });
			writeFileSync(join(hostRoot, relPath, "state"), relPath);
		}
		const workspace = await createPlanWorkspace(hostRoot);
		try {
			for (const relPath of [join(".pi", "worktrees", "feature"), join(".pi", "repos", "snapshot"), ".git"]) {
				expect(readFileSync(join(workspace.sandboxRoot, relPath, "state"), "utf8")).toBe(relPath);
			}
		} finally {
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== "win32")("disposes copies containing immutable repository snapshots", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		const externalRoot = mkdtempSync(join(tmpdir(), "pi-plan-external-"));
		const source = join(hostRoot, ".pi", "repos", "snapshot", "source");
		const readOnlyDirectories = [source, join(source, ".github"), join(source, ".github", "workflows")];
		const workflow = join(readOnlyDirectories.at(-1)!, "ci.yml");
		mkdirSync(readOnlyDirectories.at(-1)!, { recursive: true });
		writeFileSync(workflow, "name: CI\n");
		symlinkSync(externalRoot, join(source, "outside-link"));
		chmodSync(workflow, 0o444);
		chmodSync(externalRoot, 0o500);
		for (const directory of [...readOnlyDirectories].reverse()) chmodSync(directory, 0o555);

		try {
			const workspace = await createPlanWorkspace(hostRoot);
			const copiedSource = join(workspace.sandboxRoot, ".pi", "repos", "snapshot", "source");
			expect(lstatSync(copiedSource).mode & 0o777).toBe(0o555);

			await expect(workspace.dispose()).resolves.toBeUndefined();
			expect(existsSync(workspace.root)).toBe(false);
			expect(lstatSync(source).mode & 0o777).toBe(0o555);
			expect(lstatSync(workflow).mode & 0o777).toBe(0o444);
			expect(lstatSync(externalRoot).mode & 0o777).toBe(0o500);
		} finally {
			for (const directory of readOnlyDirectories) chmodSync(directory, 0o755);
			chmodSync(externalRoot, 0o700);
			rmSync(hostRoot, { recursive: true, force: true });
			rmSync(externalRoot, { recursive: true, force: true });
		}
	});

	it("uses the fs.cp fallback on win32", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		const workspace = await createPlanWorkspace(hostRoot, {
			platform: "win32",
			supportsCloning: async () => true,
			runCloneCommand: async () => { throw new Error("must not clone"); },
		});
		try {
			expect(readFileSync(join(workspace.sandboxRoot, "tracked.txt"), "utf8")).toBe("host\n");
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

	it("produces equivalent complete trees with clone and fs.cp strategies", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-host-"));
		const externalRoot = mkdtempSync(join(tmpdir(), "pi-plan-external-"));
		mkdirSync(join(hostRoot, "nested", "node_modules"), { recursive: true });
		mkdirSync(join(hostRoot, "nested", "kept"), { recursive: true });
		writeFileSync(join(hostRoot, "root.txt"), "root\n");
		writeFileSync(join(hostRoot, "-odd-name"), "odd\n");
		writeFileSync(join(hostRoot, "nested", "kept", "script.sh"), "#!/bin/sh\n");
		writeFileSync(join(hostRoot, "nested", "node_modules", "dep.js"), "dep\n");
		writeFileSync(join(externalRoot, "outside.txt"), "outside\n");
		chmodSync(join(hostRoot, "nested"), 0o750);
		chmodSync(join(hostRoot, "nested", "kept", "script.sh"), 0o751);
		symlinkSync(join(externalRoot, "outside.txt"), join(hostRoot, "nested", "outside-link"));
		const fallback = await createPlanWorkspace(hostRoot, { supportsCloning: async () => false });
		const cloned = await createPlanWorkspace(hostRoot, { supportsCloning: async () => true });
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
