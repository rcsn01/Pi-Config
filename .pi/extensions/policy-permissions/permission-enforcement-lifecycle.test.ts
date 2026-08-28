import { describe, expect, it, vi } from "vitest";
import type { ExecPolicyConfig } from "../_shared/command-policy.ts";
import {
	createPermissionEnforcementLifecycle,
	permissionActionKey,
	type PermissionEnforcementLifecycleAdapter,
} from "./permission-enforcement-lifecycle.ts";
import type { ModeState } from "./mode-store.ts";

const ALLOW_POLICY: ExecPolicyConfig = { rules: [], defaultAction: "allow" };

function createHarness(options: {
	mode?: ModeState;
	confirmations?: boolean[];
	guardianResult?: { allowed: boolean; reason?: string; model?: string };
	guardianError?: unknown;
	persistError?: unknown;
	loadError?: unknown;
	saveError?: unknown;
} = {}) {
	const confirmations = [...(options.confirmations ?? [])];
	const requestUserConfirmation = vi.fn(async () => confirmations.shift() ?? false);
	const adapter: PermissionEnforcementLifecycleAdapter<Record<string, never>> = {
		loadMode: vi.fn(() => {
			if (options.loadError) throw options.loadError;
			return options.mode;
		}),
		saveMode: vi.fn(() => {
			if (options.saveError) throw options.saveError;
		}),
		requestUserConfirmation,
		runGuardianReview: vi.fn(async () => {
			if (options.guardianError) throw options.guardianError;
			return options.guardianResult ?? { allowed: true, reason: "safe" };
		}),
		persistGuardianVerdict: vi.fn(() => {
			if (options.persistError) throw options.persistError;
		}),
	};
	const lifecycle = createPermissionEnforcementLifecycle(adapter, { now: () => 42 });
	lifecycle.synchronizeSession({ cwd: "/workspace", resetTransientApprovals: true });
	const evaluate = (toolName: string, input: unknown, overrides: Partial<{
		hasUI: boolean;
		execPolicy: ExecPolicyConfig;
	}> = {}) => lifecycle.evaluate(
		{ toolName, input },
		{
			cwd: "/workspace",
			hasUI: overrides.hasUI ?? true,
			execPolicy: overrides.execPolicy ?? ALLOW_POLICY,
			guardianContext: {
				lastUserPrompt: "install the package",
				precedingAssistantMessage: "I will use curl",
			},
			hostContext: {},
		},
	);
	return { adapter, requestUserConfirmation, lifecycle, evaluate };
}

describe("PermissionEnforcementLifecycle", () => {
	it("loads mode, updates it live, and persists against the current cwd", () => {
		const harness = createHarness({ mode: { mode: "read-only", setAt: 1 } });
		expect(harness.lifecycle.mode).toEqual({ mode: "read-only", setAt: 1 });
		const changed = { mode: "auto-review", setAt: 2 } as const;
		expect(harness.lifecycle.changeMode(changed)).toEqual({ mode: changed });
		expect(harness.adapter.saveMode).toHaveBeenCalledWith("/workspace", changed);
	});

	it("keeps mode live when best-effort persistence fails", () => {
		const harness = createHarness({ saveError: new Error("disk full") });
		expect(() => harness.lifecycle.changeMode({ mode: "full-access", setAt: 2 })).not.toThrow();
		expect(harness.lifecycle.mode.mode).toBe("full-access");
	});

	it("clears transient approvals when the permission mode changes", async () => {
		const harness = createHarness({ confirmations: [false] });
		await harness.evaluate("ddg_search", { query: "x" });
		harness.lifecycle.approveLastDenied();
		harness.lifecycle.changeMode({ mode: "read-only", setAt: 2 });
		expect(await harness.evaluate("ddg_search", { query: "x" })).toEqual(
			expect.objectContaining({ kind: "blocked", approvable: false }),
		);
	});

	it("uses one mode snapshot throughout an in-flight evaluation", async () => {
		const harness = createHarness();
		let finish!: (approved: boolean) => void;
		harness.requestUserConfirmation.mockImplementation(() =>
			new Promise<boolean>((resolve) => { finish = resolve; })
		);
		const pending = harness.evaluate("ddg_search", { query: "x" });
		harness.lifecycle.changeMode({ mode: "full-access", setAt: 2 });
		finish(true);
		expect(await pending).toEqual({ kind: "allowed", source: "user" });
	});

	it("does not carry an in-flight denial across a mode change", async () => {
		const harness = createHarness();
		let finish!: (approved: boolean) => void;
		harness.requestUserConfirmation.mockImplementation(() =>
			new Promise<boolean>((resolve) => { finish = resolve; })
		);
		const pending = harness.evaluate("ddg_search", { query: "x" });
		harness.lifecycle.changeMode({ mode: "read-only", setAt: 2 });
		finish(false);
		expect(await pending).toEqual(expect.objectContaining({ kind: "blocked", approvable: false }));
		expect(harness.lifecycle.approveLastDenied()).toEqual({ kind: "none" });
	});

	it("falls back to default mode when loading fails", () => {
		const harness = createHarness({ loadError: new Error("bad state") });
		expect(harness.lifecycle.mode.mode).toBe("default");
	});

	it("matches one-shot approval with canonical object ordering and consumes it once", async () => {
		const harness = createHarness({ confirmations: [false, false] });
		const first = await harness.evaluate("ddg_search", { query: "x", count: 1 });
		expect(first).toEqual(expect.objectContaining({ kind: "blocked", approvable: true }));
		expect(harness.lifecycle.approveLastDenied()).toEqual({
			kind: "approved",
			action: expect.objectContaining({ at: 42 }),
		});
		expect(await harness.evaluate("ddg_search", { count: 1, query: "x" })).toEqual({
			kind: "allowed",
			source: "one-shot",
		});
		expect((await harness.evaluate("ddg_search", { query: "x", count: 1 })).kind).toBe("blocked");
	});

	it("resets transient approval state at session start", async () => {
		const harness = createHarness({ confirmations: [false, false] });
		await harness.evaluate("ddg_search", { query: "x" });
		harness.lifecycle.approveLastDenied();
		harness.lifecycle.synchronizeSession({ cwd: "/workspace", resetTransientApprovals: true });
		expect((await harness.evaluate("ddg_search", { query: "x" })).kind).toBe("blocked");
		expect(harness.lifecycle.approveLastDenied().kind).toBe("approved");
	});

	it("retains transient approval state when only the session tree changes", async () => {
		const harness = createHarness({ confirmations: [false] });
		await harness.evaluate("ddg_search", { query: "x" });
		harness.lifecycle.approveLastDenied();
		harness.lifecycle.synchronizeSession({ cwd: "/workspace", resetTransientApprovals: false });
		expect(await harness.evaluate("ddg_search", { query: "x" })).toEqual({
			kind: "allowed",
			source: "one-shot",
		});
	});

	it("does not make static policy blocks approvable", async () => {
		const harness = createHarness({ mode: { mode: "read-only", setAt: 1 } });
		expect(await harness.evaluate("write", { path: "/workspace/a" })).toEqual({
			kind: "blocked",
			reason: expect.stringContaining("read-only"),
			approvable: false,
		});
		expect(harness.lifecycle.approveLastDenied()).toEqual({ kind: "none" });
	});

	it("clears an older prompted denial when a later static block completes", async () => {
		const harness = createHarness({ confirmations: [false] });
		await harness.evaluate("ddg_search", { query: "x" });
		await harness.evaluate("bash", { command: "rm file" }, {
			execPolicy: {
				rules: [{ id: "block-rm", pattern: "^rm ", action: "block", reason: "blocked" }],
				defaultAction: "allow",
			},
		});
		expect(harness.lifecycle.approveLastDenied()).toEqual({ kind: "none" });
	});

	it("persists successful Guardian verdicts with context and triggers", async () => {
		const harness = createHarness({
			mode: { mode: "auto-review", setAt: 1 },
			guardianResult: { allowed: true, reason: "safe", model: "openai/guardian" },
		});
		expect(await harness.evaluate("bash", { command: "sudo rm -rf /workspace/x" })).toEqual({
			kind: "allowed",
			source: "guardian",
		});
		expect(harness.adapter.runGuardianReview).toHaveBeenCalledWith(
			{},
			"Command Review",
			expect.stringContaining("User request: install the package"),
			["dangerous"],
		);
		expect(harness.adapter.persistGuardianVerdict).toHaveBeenCalledWith({}, {
			allowed: true,
			reason: "safe",
			model: "openai/guardian",
			title: "Command Review",
			triggers: ["dangerous"],
		});
	});

	it("records a Guardian denial as approvable", async () => {
		const harness = createHarness({
			mode: { mode: "auto-review", setAt: 1 },
			guardianResult: { allowed: false, reason: "unsafe" },
		});
		expect(await harness.evaluate("bash", { command: "sudo rm -rf /workspace/x" })).toEqual({
			kind: "blocked",
			reason: "unsafe",
			approvable: true,
		});
		expect(harness.lifecycle.approveLastDenied().kind).toBe("approved");
	});

	it.each(["review", "persistence"] as const)("falls back to user confirmation after Guardian %s failure", async (failure) => {
		const harness = createHarness({
			mode: { mode: "auto-review", setAt: 1 },
			confirmations: [true],
			guardianError: failure === "review" ? new Error("offline") : undefined,
			persistError: failure === "persistence" ? new Error("entry failed") : undefined,
		});
		expect(await harness.evaluate("bash", { command: "sudo rm -rf /workspace/x" })).toEqual({
			kind: "allowed",
			source: "user",
		});
		expect(harness.adapter.requestUserConfirmation).toHaveBeenCalledWith(
			{},
			expect.stringContaining("guardian unavailable"),
			expect.stringContaining("Guardian could not evaluate"),
		);
	});

	it("fails closed without UI instead of invoking Guardian", async () => {
		const harness = createHarness({ mode: { mode: "auto-review", setAt: 1 } });
		expect(await harness.evaluate("bash", { command: "sudo rm -rf /workspace/x" }, { hasUI: false }))
			.toEqual(expect.objectContaining({ kind: "blocked", approvable: false }));
		expect(harness.lifecycle.approveLastDenied()).toEqual({ kind: "none" });
		expect(harness.adapter.runGuardianReview).not.toHaveBeenCalled();
	});
});

describe("permissionActionKey", () => {
	it("is stable across property ordering and distinct across tools", () => {
		expect(permissionActionKey("bash", { command: "ls", timeout: 1 })).toBe(
			permissionActionKey("bash", { timeout: 1, command: "ls" }),
		);
		expect(permissionActionKey("bash", { command: "ls" })).not.toBe(
			permissionActionKey("write", { command: "ls" }),
		);
	});

	it("does not collapse distinct unknown input values", () => {
		const keys = [undefined, null, {}, NaN, Infinity, { value: undefined }, { value: null }, [], Array(1)]
			.map((value) => permissionActionKey("tool", value));
		expect(new Set(keys).size).toBe(keys.length);
	});
});
