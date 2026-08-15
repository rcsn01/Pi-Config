import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanWorkspace } from "./plan-workspace.ts";
import { createPlanSandboxController } from "./plan-sandbox.ts";

function fixtureWorkspace(): PlanWorkspace {
	const root = mkdtempSync(join(tmpdir(), "pi-plan-sandbox-test-"));
	return {
		root,
		hostRoot: "/host/project",
		sandboxRoot: join(root, "project"),
		tempRoot: join(root, "tmp"),
		async dispose() { rmSync(root, { recursive: true, force: true }); },
	};
}

describe("createPlanSandboxController", () => {
	it("forwards arbitrary commands into the mapped disposable workspace", async () => {
		const workspace = fixtureWorkspace();
		const runtime = {
			initialize: vi.fn(async () => {}),
			wrapWithSandboxArgv: vi.fn(async () => ({ argv: ["/bin/bash", "-c", "wrapped"], env: { PROXY: "1" } })),
			annotateStderrWithSandboxFailures: vi.fn((_id: string, stderr: string) => stderr),
			cleanupAfterCommand: vi.fn(),
			reset: vi.fn(async () => {}),
		};
		const run = vi.fn(async (_argv, options) => {
			options.onData(Buffer.from("ok\n"));
			return { exitCode: 0, stderr: "" };
		});
		const controller = createPlanSandboxController(workspace, { runtime, run });
		await controller.initialize();
		const onData = vi.fn();

		await expect(controller.operations.exec(
			`npm --prefix apps/Amove run test:e2e -- --grep "navigation"`,
			"/host/project/apps/Amove",
			{ onData, env: { PATH: "/bin" }, timeout: 30 },
		)).resolves.toEqual({ exitCode: 0 });

		expect(runtime.wrapWithSandboxArgv).toHaveBeenCalledWith(
			`npm --prefix apps/Amove run test:e2e -- --grep "navigation"`,
			undefined,
			undefined,
			undefined,
			expect.stringContaining("/project/apps/Amove"),
			expect.objectContaining({ commandText: expect.stringContaining("npm --prefix") }),
		);
		expect(run).toHaveBeenCalledWith(
			["/bin/bash", "-c", "wrapped"],
			expect.objectContaining({
				cwd: expect.stringContaining("/project/apps/Amove"),
				env: expect.objectContaining({ PATH: "/bin", PROXY: "1", TMPDIR: workspace.tempRoot }),
				timeout: 30,
			}),
		);
		expect(onData).toHaveBeenCalledWith(Buffer.from("ok\n"));
		await controller.dispose();
		expect(runtime.reset).toHaveBeenCalledOnce();
		await workspace.dispose();
	});

	it("resets partially initialized runtime state when initialization fails", async () => {
		const workspace = fixtureWorkspace();
		const runtime = {
			initialize: vi.fn(async () => { throw new Error("proxy startup failed"); }),
			wrapWithSandboxArgv: vi.fn(),
			annotateStderrWithSandboxFailures: vi.fn(),
			cleanupAfterCommand: vi.fn(),
			reset: vi.fn(async () => {}),
		};
		const controller = createPlanSandboxController(workspace, { runtime, run: vi.fn() });
		await expect(controller.initialize()).rejects.toThrow("proxy startup failed");
		expect(runtime.reset).toHaveBeenCalledOnce();
		await controller.dispose();
		expect(runtime.reset).toHaveBeenCalledOnce();
		await workspace.dispose();
	});

	it("rejects host working directories outside the workspace", async () => {
		const workspace = fixtureWorkspace();
		const runtime = {
			initialize: vi.fn(async () => {}),
			wrapWithSandboxArgv: vi.fn(),
			annotateStderrWithSandboxFailures: vi.fn(),
			cleanupAfterCommand: vi.fn(),
			reset: vi.fn(async () => {}),
		};
		const controller = createPlanSandboxController(workspace, { runtime, run: vi.fn() });
		await controller.initialize();
		await expect(controller.operations.exec("pwd", "/outside", { onData: vi.fn() }))
			.rejects.toThrow("outside the host workspace");
		await controller.dispose();
		await workspace.dispose();
	});
});
