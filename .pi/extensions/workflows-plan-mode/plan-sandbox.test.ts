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
		hostRoot: join(root, "host-project"),
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
			wrapWithSandboxArgv: vi.fn(async () => ({ argv: ["sandbox-runtime", "wrapped"], env: { PROXY: "1" } })),
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
		expect(runtime.initialize).toHaveBeenCalledWith(expect.objectContaining({
			network: expect.objectContaining({ allowedDomains: [], allowLocalBinding: false }),
		}));
		const onData = vi.fn();

		await expect(controller.operations.exec(
			`npm --prefix apps/Amove run test:e2e -- --grep "navigation"`,
			join(workspace.hostRoot, "apps", "Amove"),
			{ onData, env: { PATH: "/bin" }, timeout: 30 },
		)).resolves.toEqual({ exitCode: 0 });

		const originalCommand = `npm --prefix apps/Amove run test:e2e -- --grep "navigation"`;
		const wrappedCommand = process.platform === "win32"
			? expect.stringMatching(/^set "TMPDIR=.*set "TEMP=.*set "TMP=.*set "PI_PLAN_WORKSPACE=.*npm --prefix/s)
			: expect.stringMatching(/export TMPDIR=.*TEMP=.*TMP=.*PI_PLAN_WORKSPACE=.*npm --prefix/s);
		expect(runtime.wrapWithSandboxArgv).toHaveBeenCalledWith(
			wrappedCommand,
			undefined,
			undefined,
			expect.any(AbortSignal),
			join(workspace.root, "project", "apps", "Amove"),
			expect.objectContaining({ commandText: originalCommand }),
		);
		expect(run).toHaveBeenCalledWith(
			["sandbox-runtime", "wrapped"],
			expect.objectContaining({
				cwd: join(workspace.sandboxRoot, "apps", "Amove"),
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

	it("aborts and drains active commands before resetting the sandbox", async () => {
		const workspace = fixtureWorkspace();
		let runSignal: AbortSignal | undefined;
		let finishRun!: () => void;
		const run = vi.fn((_argv, options) => {
			runSignal = options.signal;
			return new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
				finishRun = () => resolve({ exitCode: 0, stderr: "" });
			});
		});
		const timeline: string[] = [];
		const runtime = {
			initialize: vi.fn(async () => {}),
			wrapWithSandboxArgv: vi.fn(async () => ({ argv: ["/bin/bash", "-c", "wrapped"], env: {} })),
			annotateStderrWithSandboxFailures: vi.fn((_id: string, stderr: string) => stderr),
			cleanupAfterCommand: vi.fn(),
			reset: vi.fn(async () => { timeline.push("reset"); }),
		};
		const controller = createPlanSandboxController(workspace, { runtime, run });
		await controller.initialize();
		const execution = controller.operations.exec("sleep 30", workspace.hostRoot, {
			onData: vi.fn(),
		});
		await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

		const disposing = controller.dispose();
		await Promise.resolve();
		expect(runSignal?.aborted).toBe(true);
		expect(runtime.reset).not.toHaveBeenCalled();

		finishRun();
		await execution;
		await disposing;
		expect(timeline).toEqual(["reset"]);
		await workspace.dispose();
	});

	it("retries sandbox reset when disposal fails", async () => {
		const workspace = fixtureWorkspace();
		const runtime = {
			initialize: vi.fn(async () => {}),
			wrapWithSandboxArgv: vi.fn(),
			annotateStderrWithSandboxFailures: vi.fn(),
			cleanupAfterCommand: vi.fn(),
			reset: vi.fn()
				.mockRejectedValueOnce(new Error("reset failed"))
				.mockResolvedValueOnce(undefined),
		};
		const controller = createPlanSandboxController(workspace, { runtime, run: vi.fn() });
		await controller.initialize();

		await expect(controller.dispose()).rejects.toThrow("reset failed");
		await expect(controller.dispose()).resolves.toBeUndefined();
		expect(runtime.reset).toHaveBeenCalledTimes(2);
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
		await expect(controller.operations.exec("pwd", join(workspace.root, "..", "outside"), { onData: vi.fn() }))
			.rejects.toThrow("outside the host workspace");
		await controller.dispose();
		await workspace.dispose();
	});
});
