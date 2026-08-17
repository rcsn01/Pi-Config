import { describe, expect, it, vi } from "vitest";
import { createSubscriptionUsageExtension, formatAuthStatus } from "./index.ts";
import type { CodexAuthStatus } from "./types.ts";

function harness(status: CodexAuthStatus) {
	const commands = new Map<string, any>();
	const checkAuth = vi.fn(async () => status);
	createSubscriptionUsageExtension({ checkAuth })(
		{ registerCommand: (name: string, command: any) => commands.set(name, command) } as any,
	);
	const notify = vi.fn();
	const controller = new AbortController();
	return {
		command: commands.get("usage"),
		checkAuth,
		notify,
		ctx: { signal: controller.signal, ui: { notify } },
	};
}

const accepted: CodexAuthStatus = {
	state: "accepted",
	path: "/home/user/.codex/auth.json",
	fileFound: true,
	accessTokenPresent: true,
	accountIdPresent: true,
	credentialAccepted: true,
};

describe("/usage auth status", () => {
	it("reports every authentication checkpoint without exposing credentials", async () => {
		const { command, checkAuth, notify, ctx } = harness(accepted);
		await command.handler("auth status", ctx);
		expect(checkAuth).toHaveBeenCalledWith({ signal: ctx.signal });
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("ChatGPT credential: accepted"),
			"info",
		);
		const output = notify.mock.calls[0][0];
		expect(output).toContain("Auth file: found");
		expect(output).toContain("Access token: present");
		expect(output).toContain("Account ID: present");
	});

	it("reports actionable failures as warnings", async () => {
		const status: CodexAuthStatus = {
			state: "missing", path: "/missing/auth.json", fileFound: false,
			accessTokenPresent: false, accountIdPresent: false, credentialAccepted: false,
			message: "Run `codex login` and try again.",
		};
		const { command, notify, ctx } = harness(status);
		await command.handler("auth", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run `codex login`"), "warning");
		expect(formatAuthStatus(status)).toContain("ChatGPT credential: not accepted");
	});

	it("does not guess an analytics endpoint for the default command", async () => {
		const { command, checkAuth, notify, ctx } = harness(accepted);
		await command.handler("", ctx);
		expect(checkAuth).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("endpoint discovery is pending"), "info");
	});
});
