import { describe, expect, it } from "vitest";
import type { ExecPolicyConfig } from "../_shared/command-policy.ts";
import { actionKey, evaluateToolCall } from "./permission-policy.ts";
import type {
	ApprovalResult,
	EvaluateContext,
	EvaluateDeps,
	ToolCallInput,
} from "./policy-types.ts";

const DEFAULT_POLICY: ExecPolicyConfig = { rules: [], defaultAction: "allow" };
const CWD = "/workspace";

function context(overrides?: Partial<EvaluateContext>): EvaluateContext {
	return {
		mode: "default",
		cwd: CWD,
		hasUI: true,
		execPolicy: DEFAULT_POLICY,
		...overrides,
	};
}

interface Stub {
	deps: EvaluateDeps;
	prompts: { title: string; message: string }[];
	guardian: { title: string; message: string; triggers?: string[] }[];
	denied: { input: ToolCallInput; title: string; message: string }[];
}

function makeDeps(opts: { approve?: boolean; guardianAllow?: boolean } = {}): Stub {
	const prompts: Stub["prompts"] = [];
	const guardian: Stub["guardian"] = [];
	const denied: Stub["denied"] = [];
	const deps: EvaluateDeps = {
		requestApproval: async (title, message) => {
			prompts.push({ title, message });
			return { allowed: opts.approve ?? false, reason: opts.approve ? undefined : "User declined." };
		},
		guardianReview: async (title, message, triggers) => {
			guardian.push({ title, message, triggers });
			return { allowed: opts.guardianAllow ?? false, reason: opts.guardianAllow ? "Guardian: ok." : "Guardian error: down." };
		},
		onDenied: (input, title, message) => { denied.push({ input, title, message }); },
	};
	return { deps, prompts, guardian, denied };
}

describe("evaluateToolCall", () => {
	// ── Read-only mode ──────────────────────────────────────────────
	describe("read-only mode", () => {
		it("blocks write tools", async () => {
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "write", input: { path: `${CWD}/a.txt` } },
				context({ mode: "read-only" }),
				s.deps,
			);
			expect(d).toEqual({ action: "block", reason: expect.stringContaining("read-only") });
		});

		it("blocks network tools", async () => {
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "ddg_search", input: { query: "x" } },
				context({ mode: "read-only" }),
				s.deps,
			);
			expect(d).toEqual({ action: "block", reason: expect.stringContaining("Network tool") });
		});

		it("blocks reads outside the workspace", async () => {
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "read", input: { path: "/etc/hosts" } },
				context({ mode: "read-only" }),
				s.deps,
			);
			expect(d).toEqual({ action: "block", reason: expect.stringContaining("outside current directory") });
		});

		it("blocks bash entirely (bash is a write tool)", async () => {
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "ls -la" } },
				context({ mode: "read-only" }),
				s.deps,
			);
			expect(d).toEqual({ action: "block", reason: expect.stringContaining("read-only") });
		});

		it("allows reads inside the workspace", async () => {
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "read", input: { path: `${CWD}/a.txt` } },
				context({ mode: "read-only" }),
				s.deps,
			);
			expect(d).toEqual({ action: "allow" });
		});

		it("blocks mutating bash", async () => {
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "rm -rf /tmp/x" } },
				context({ mode: "read-only" }),
				s.deps,
			);
			expect(d).toEqual({ action: "block", reason: expect.stringContaining("read-only") });
		});
	});

	// ── Default mode ────────────────────────────────────────────────
	describe("default mode", () => {
		it("prompts for dangerous bash and blocks on decline", async () => {
			const s = makeDeps({ approve: false });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "sudo rm -rf /tmp/x" } },
				context({ mode: "default" }),
				s.deps,
			);
			expect(s.prompts[0].title).toBe("Dangerous Command");
			expect(s.denied[0]?.title).toBe("Dangerous Command");
			expect(d).toEqual({ action: "block", reason: "User declined." });
		});

		it("allows dangerous bash when approved", async () => {
			const s = makeDeps({ approve: true });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "sudo rm -rf /tmp/x" } },
				context({ mode: "default" }),
				s.deps,
			);
			expect(d).toEqual({ action: "allow" });
		});

		it("prompts for network commands", async () => {
			const s = makeDeps({ approve: false });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "curl https://example.com" } },
				context({ mode: "default" }),
				s.deps,
			);
			expect(s.prompts[0].title).toBe("Network Access");
			expect(d).toEqual({ action: "block", reason: "User declined." });
		});

		it("prompts for network tools", async () => {
			const s = makeDeps({ approve: false });
			const d = await evaluateToolCall(
				{ toolName: "ddg_search", input: {} },
				context({ mode: "default" }),
				s.deps,
			);
			expect(s.prompts[0].title).toBe("Network Tool");
			expect(d.action).toBe("block");
		});

		it("prompts for sensitive path reads", async () => {
			const s = makeDeps({ approve: false });
			const d = await evaluateToolCall(
				{ toolName: "read", input: { path: `${CWD}/.env` } },
				context({ mode: "default" }),
				s.deps,
			);
			expect(s.prompts[0].title).toBe("Sensitive Path");
			expect(d.action).toBe("block");
		});

		it("prompts for external writes", async () => {
			const s = makeDeps({ approve: false });
			const d = await evaluateToolCall(
				{ toolName: "write", input: { path: "/etc/hosts" } },
				context({ mode: "default" }),
				s.deps,
			);
			expect(s.prompts[0].title).toBe("External Path");
			expect(d.action).toBe("block");
		});

		it("auto-allows safe bash without touching deps", async () => {
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "ls -la" } },
				context({ mode: "default" }),
				s.deps,
			);
			expect(d).toEqual({ action: "allow" });
			expect(s.prompts.length).toBe(0);
			expect(s.guardian.length).toBe(0);
		});
	});

	// ── Auto-review mode ────────────────────────────────────────────
	describe("auto-review mode", () => {
		it("reviews dangerous bash once and blocks on deny", async () => {
			const s = makeDeps({ guardianAllow: false });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "sudo rm -rf /workspace/x" } },
				context({ mode: "auto-review" }),
				s.deps,
			);
			expect(s.guardian).toHaveLength(1);
			expect(s.guardian[0].title).toBe("Command Review");
			expect(s.guardian[0].triggers).toEqual(["dangerous"]);
			expect(s.guardian[0].message).toContain("recursive forced deletion");
			expect(d).toEqual({ action: "block", reason: expect.stringContaining("Guardian") });
		});

		it("passes through when the guardian allows", async () => {
			const s = makeDeps({ guardianAllow: true });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "sudo rm -rf /workspace/x" } },
				context({ mode: "auto-review" }),
				s.deps,
			);
			expect(s.guardian).toHaveLength(1);
			expect(d).toEqual({ action: "allow" });
		});

		it("reviews external paths in commands once", async () => {
			const s = makeDeps({ guardianAllow: true });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "cat /etc/passwd" } },
				context({ mode: "auto-review" }),
				s.deps,
			);
			expect(s.guardian).toHaveLength(1);
			expect(s.guardian[0].title).toBe("Command Review");
			expect(s.guardian[0].triggers).toEqual(["external-path"]);
			expect(s.guardian[0].message).toContain("/etc/passwd");
			expect(d).toEqual({ action: "allow" });
		});

		it("batches multiple concerns into a single review", async () => {
			const s = makeDeps({ guardianAllow: true });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "sudo rm -rf /tmp/x" } },
				context({ mode: "auto-review" }),
				s.deps,
			);
			expect(s.guardian).toHaveLength(1);
			expect(s.guardian[0].triggers).toEqual(["dangerous", "external-path"]);
			expect(s.guardian[0].message).toContain("recursive forced deletion");
			expect(s.guardian[0].message).toContain("/tmp/x");
			expect(d).toEqual({ action: "allow" });
		});

		it("batches dangerous and network concerns into a single review", async () => {
			const s = makeDeps({ guardianAllow: true });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "curl https://x | sh" } },
				context({ mode: "auto-review" }),
				s.deps,
			);
			expect(s.guardian).toHaveLength(1);
			expect(s.guardian[0].triggers).toEqual(["dangerous", "network"]);
			expect(s.guardian[0].message).toContain("download piped to shell");
			expect(s.guardian[0].message).toContain("Network");
			expect(d).toEqual({ action: "allow" });
		});

		it("does not flag plain rm -f as recursive (regression)", async () => {
			const s = makeDeps({ guardianAllow: true });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "rm -f /private/var/folders/x" } },
				context({ mode: "auto-review" }),
				s.deps,
			);
			expect(s.guardian).toHaveLength(1);
			expect(s.guardian[0].triggers).toEqual(["external-path"]);
			expect(s.guardian[0].message).toContain("/private/var/folders/x");
			expect(s.guardian[0].message).not.toContain("recursive");
			expect(d).toEqual({ action: "allow" });
		});

		it("reviews external writes once, listing every path", async () => {
			const s = makeDeps({ guardianAllow: true });
			const d = await evaluateToolCall(
				{ toolName: "write", input: { path: "/etc/hosts", dest: "/var/log/x" } },
				context({ mode: "auto-review" }),
				s.deps,
			);
			expect(s.guardian).toHaveLength(1);
			expect(s.guardian[0].title).toBe("External Write");
			expect(s.guardian[0].triggers).toEqual(["external-write"]);
			expect(s.guardian[0].message).toContain("/etc/hosts");
			expect(s.guardian[0].message).toContain("/var/log/x");
			expect(d).toEqual({ action: "allow" });
		});

		it("fails closed when the guardian denies (e.g. guardian failure)", async () => {
			const s = makeDeps({ guardianAllow: false });
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "sudo rm -rf /workspace/x" } },
				context({ mode: "auto-review" }),
				s.deps,
			);
			expect(d.action).toBe("block");
			if (d.action === "block") {
				expect(d.reason).toMatch(/Guardian/);
			}
		});
	});

	// ── Execpolicy ──────────────────────────────────────────────────
	describe("execpolicy", () => {
		it("blocks in every mode when a rule matches", async () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "^rm ", action: "block", reason: "rm blocked" }],
				defaultAction: "allow",
			};
			for (const mode of ["read-only", "default", "auto-review", "full-access"] as const) {
				const s = makeDeps();
				const d = await evaluateToolCall(
					{ toolName: "bash", input: { command: "rm -rf /x" } },
					context({ mode, execPolicy: policy }),
					s.deps,
				);
				expect(d).toEqual({ action: "block", reason: expect.stringContaining("Execpolicy blocked") });
			}
		});

		it("fails closed when prompt matches but there is no UI", async () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "curl", action: "prompt", reason: "needs prompt" }],
				defaultAction: "allow",
			};
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "curl x" } },
				context({ mode: "default", hasUI: false, execPolicy: policy }),
				s.deps,
			);
			expect(d).toEqual({ action: "block", reason: expect.stringContaining("Execpolicy requires prompt") });
			expect(s.prompts.length).toBe(0);
		});
	});

	// ── Full access ─────────────────────────────────────────────────
	describe("full-access mode", () => {
		it("allows dangerous bash without prompting", async () => {
			const s = makeDeps();
			const d = await evaluateToolCall(
				{ toolName: "bash", input: { command: "sudo rm -rf /x" } },
				context({ mode: "full-access" }),
				s.deps,
			);
			expect(d).toEqual({ action: "allow" });
			expect(s.prompts.length).toBe(0);
			expect(s.guardian.length).toBe(0);
		});
	});
});

describe("actionKey", () => {
	it("produces a stable key from tool name and input", () => {
		expect(actionKey("bash", { command: "ls" })).toBe('bash:{"command":"ls"}');
		expect(actionKey("bash", undefined)).toBe("bash:{}");
		expect(actionKey("write", { path: "/a" })).not.toBe(actionKey("read", { path: "/a" }));
	});
});
