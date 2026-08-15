import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanSandboxController } from "./plan-sandbox.ts";
import { createPlanWorkspace } from "./plan-workspace.ts";

const sandboxIt = process.env.RUN_PLAN_SANDBOX_INTEGRATION === "1" ? it : it.skip;

describe("Plan Bash OS sandbox", () => {
	sandboxIt("allows arbitrary writes in the disposable copy but not on the host", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-sandbox-host-"));
		const externalFile = join(tmpdir(), `pi-plan-sandbox-external-${process.pid}-${Date.now()}`);
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		const workspace = await createPlanWorkspace(hostRoot);
		const controller = createPlanSandboxController(workspace);
		try {
			await controller.initialize();
			const output: Buffer[] = [];
			const localResult = await controller.operations.exec(
				"printf 'sandbox\\n' > tracked.txt; printf 'artifact\\n' > artifact.txt",
				hostRoot,
				{ onData: (chunk) => output.push(chunk) },
			);
			expect(localResult.exitCode).toBe(0);
			expect(readFileSync(join(hostRoot, "tracked.txt"), "utf8")).toBe("host\n");
			expect(existsSync(join(hostRoot, "artifact.txt"))).toBe(false);
			expect(readFileSync(join(workspace.sandboxRoot, "tracked.txt"), "utf8")).toBe("sandbox\n");

			const externalResult = await controller.operations.exec(
				`printf 'escaped\\n' > '${externalFile}'`,
				hostRoot,
				{ onData: (chunk) => output.push(chunk) },
			);
			expect(externalResult.exitCode).not.toBe(0);
			expect(existsSync(externalFile)).toBe(false);
		} finally {
			await controller.dispose();
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
			rmSync(externalFile, { force: true });
		}
	});
});
