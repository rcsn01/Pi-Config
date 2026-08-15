import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanSandboxController } from "./plan-sandbox.ts";
import { createPlanWorkspace } from "./plan-workspace.ts";

const sandboxIt = process.env.RUN_PLAN_SANDBOX_INTEGRATION === "1" && process.platform !== "win32" ? it : it.skip;

describe("Plan Bash OS sandbox", () => {
	sandboxIt("allows arbitrary writes in the disposable copy but not on the host", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-plan-sandbox-host-"));
		const externalFile = join(tmpdir(), `pi-plan-sandbox-external-${process.pid}-${Date.now()}`);
		writeFileSync(join(hostRoot, "tracked.txt"), "host\n");
		writeFileSync(externalFile, "external\n");
		symlinkSync(externalFile, join(hostRoot, "external-link"));
		const workspace = await createPlanWorkspace(hostRoot);
		const controller = createPlanSandboxController(workspace);
		try {
			await controller.initialize();
			const output: Buffer[] = [];
			const localResult = await controller.operations.exec(
				"printf 'sandbox\\n' > tracked.txt; printf 'artifact\\n' > artifact.txt; " +
				"printf 'temporary\\n' > \"$TMPDIR/temp-artifact.txt\"; " +
				"printf '%s\\n%s\\n' \"$TMPDIR\" \"$PI_PLAN_WORKSPACE\"",
				hostRoot,
				{ onData: (chunk) => output.push(chunk) },
			);
			expect(localResult.exitCode).toBe(0);
			expect(readFileSync(join(hostRoot, "tracked.txt"), "utf8")).toBe("host\n");
			expect(existsSync(join(hostRoot, "artifact.txt"))).toBe(false);
			expect(readFileSync(join(workspace.sandboxRoot, "tracked.txt"), "utf8")).toBe("sandbox\n");
			expect(readFileSync(join(workspace.tempRoot, "temp-artifact.txt"), "utf8")).toBe("temporary\n");
			expect(Buffer.concat(output).toString("utf8")).toContain(`${workspace.tempRoot}\n${workspace.sandboxRoot}\n`);

			const externalResult = await controller.operations.exec(
				`printf 'escaped\\n' > '${externalFile}'`,
				hostRoot,
				{ onData: (chunk) => output.push(chunk) },
			);
			expect(externalResult.exitCode).not.toBe(0);
			expect(readFileSync(externalFile, "utf8")).toBe("external\n");

			const symlinkResult = await controller.operations.exec(
				"printf 'escaped through symlink\\n' > external-link",
				hostRoot,
				{ onData: (chunk) => output.push(chunk) },
			);
			expect(symlinkResult.exitCode).not.toBe(0);
			expect(readFileSync(externalFile, "utf8")).toBe("external\n");

			let loopbackRequests = 0;
			const server = createServer((_request, response) => {
				loopbackRequests++;
				response.end("host service reached");
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			try {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Loopback test server has no TCP port.");
				const networkResult = await controller.operations.exec(
					`curl --fail --silent --show-error --max-time 2 http://127.0.0.1:${address.port}/`,
					hostRoot,
					{ onData: (chunk) => output.push(chunk) },
				);
				expect(networkResult.exitCode).not.toBe(0);
				expect(loopbackRequests).toBe(0);
			} finally {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => error ? reject(error) : resolve());
				});
			}

			const longRun = controller.operations.exec(
				"sleep 30",
				hostRoot,
				{ onData: (chunk) => output.push(chunk) },
			);
			const observedLongRun = longRun.then(
				() => undefined,
				(error) => error,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const disposeStartedAt = Date.now();
			await controller.dispose();
			const longRunError = await observedLongRun;
			expect(longRunError).toBeInstanceOf(Error);
			expect((longRunError as Error).message).toBe("aborted");
			expect(Date.now() - disposeStartedAt).toBeLessThan(5_000);
		} finally {
			await controller.dispose();
			await workspace.dispose();
			rmSync(hostRoot, { recursive: true, force: true });
			rmSync(externalFile, { force: true });
		}
	});
});
