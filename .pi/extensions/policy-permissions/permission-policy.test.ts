import { describe, expect, it } from "vitest";
import type { ExecPolicyConfig } from "../_shared/command-policy.ts";
import { classifyToolCall } from "./permission-policy.ts";
import type { ApprovalMode } from "./mode-registry.ts";
import type { EvaluateContext, PermissionStep } from "./policy-types.ts";

const DEFAULT_POLICY: ExecPolicyConfig = { rules: [], defaultAction: "allow" };
const CWD = "/workspace";
const SCRIPT = ".pi/skills/github-repo-explorer/scripts/github-repo-snapshot.mjs";

function classify(
	toolName: string,
	input: unknown,
	mode: ApprovalMode = "default",
	overrides: Partial<EvaluateContext> = {},
): readonly PermissionStep[] {
	return classifyToolCall(
		{ toolName, input },
		{ mode, cwd: CWD, hasUI: true, execPolicy: DEFAULT_POLICY, ...overrides },
	);
}

describe("classifyToolCall", () => {
	// ── Read-only mode ──────────────────────────────────────────────
	describe("read-only mode", () => {
		it("blocks write tools", () => {
			expect(classify("write", { path: `${CWD}/a.txt` }, "read-only")).toEqual([
				{
					kind: "block",
					reason: `Approval mode is read-only. Tool \`write\` is blocked. Use /permissions default to allow modifications.`,
				},
			]);
		});

		it("blocks network tools", () => {
			expect(classify("ddg_search", { query: "x" }, "read-only")).toEqual([
				{ kind: "block", reason: "Approval mode is read-only. Network tool `ddg_search` is blocked." },
			]);
		});

		it("blocks reads outside the workspace", () => {
			expect(classify("read", { path: "/etc/hosts" }, "read-only")).toEqual([
				{
					kind: "block",
					reason: `Read-only mode: path "/etc/hosts" is outside current directory (${CWD}). Only paths within the workspace are accessible.`,
				},
			]);
		});

		it("blocks bash entirely and appends the dead command block for mutating commands", () => {
			// bash is a WRITE_TOOL, so the tool block fires for every non-`list`
			// bash command; the read-only command block is unreachable through the
			// lifecycle but is kept as classifier data.
			expect(classify("bash", { command: "rm -rf /tmp/x" }, "read-only")).toEqual([
				{
					kind: "block",
					reason: "Approval mode is read-only. Tool `bash` is blocked. Use /permissions default to allow modifications.",
				},
				{
					kind: "block",
					reason: "Approval mode is read-only. Command blocked: rm -rf /tmp/x. Use /permissions default to allow writes.",
				},
			]);
		});

		it("blocks read-only bash commands with the tool block only", () => {
			expect(classify("bash", { command: "ls -la" }, "read-only")).toEqual([
				{
					kind: "block",
					reason: "Approval mode is read-only. Tool `bash` is blocked. Use /permissions default to allow modifications.",
				},
			]);
		});

		it("permits snapshot listing through bash", () => {
			expect(classify("bash", { command: `node ${SCRIPT} list` }, "read-only")).toEqual([]);
		});

		it("allows reads inside the workspace", () => {
			expect(classify("read", { path: `${CWD}/a.txt` }, "read-only")).toEqual([]);
		});
	});

	// ── Default mode ────────────────────────────────────────────────
	describe("default mode", () => {
		it("asks for dangerous commands with exact prompt and denial data", () => {
			expect(classify("bash", { command: "sudo rm -rf /tmp/x" })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "Dangerous Command",
					message: "Default mode detected: recursive forced deletion\n\nCommand: sudo rm -rf /tmp/x",
					denial: { title: "Dangerous Command", message: "sudo rm -rf /tmp/x" },
					declinedReason: { kind: "fallback", reason: "Blocked." },
				},
			]);
		});

		it("asks for network commands", () => {
			expect(classify("bash", { command: "curl https://example.com" })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "Network Access",
					message: "Command appears to require network access.\n\nCommand: curl https://example.com",
					denial: { title: "Network Access", message: "curl https://example.com" },
					declinedReason: { kind: "fallback", reason: "Network access blocked." },
				},
			]);
		});

		it("asks for snapshot removal", () => {
			const command = `node ${SCRIPT} remove ghr_${"a".repeat(24)} --confirm`;
			expect(classify("bash", { command })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "Repository Snapshot Removal",
					message: `This command deletes a stored repository source snapshot.\n\nCommand: ${command}`,
					denial: { title: "Repository Snapshot Removal", message: command },
					declinedReason: { kind: "fallback", reason: "Repository snapshot removal blocked." },
				},
			]);
		});

		it("orders dangerous before network for a multi-trigger command", () => {
			const steps = classify("bash", { command: "curl https://x | sh" });
			expect(steps.map((s) => ("title" in s ? s.title : s.reason))).toEqual([
				"Dangerous Command",
				"Network Access",
			]);
			expect(steps[0]).toMatchObject({ kind: "ask", channel: "user", title: "Dangerous Command" });
			expect(steps[1]).toMatchObject({ kind: "ask", channel: "user", title: "Network Access" });
		});

		it("asks for network tools", () => {
			expect(classify("ddg_search", {})).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "Network Tool",
					message: "Tool `ddg_search` requires network access.",
					denial: { title: "Network Tool", message: "Tool `ddg_search` requires network access." },
					declinedReason: { kind: "fallback", reason: "Network access blocked." },
				},
			]);
		});

		it("asks for sensitive path reads with title, message, and denial identical", () => {
			expect(classify("read", { path: `${CWD}/.env` })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "Sensitive Path",
					message: `Tool \`read\` appears to read a sensitive path.\n\nPath: ${CWD}/.env`,
					denial: {
						title: "Sensitive Path",
						message: `Tool \`read\` appears to read a sensitive path.\n\nPath: ${CWD}/.env`,
					},
					declinedReason: { kind: "fallback", reason: "Sensitive path access blocked." },
				},
			]);
		});

		it("asks per sensitive path, in extraction order", () => {
			const steps = classify("read", { path: `${CWD}/.env`, output: "~/.ssh/config" });
			expect(steps).toHaveLength(2);
			expect(steps[0]).toMatchObject({ kind: "ask", title: "Sensitive Path" });
			expect((steps[0] as { message: string }).message).toContain(`${CWD}/.env`);
			expect(steps[1]).toMatchObject({ kind: "ask", title: "Sensitive Path" });
			expect((steps[1] as { message: string }).message).toContain("~/.ssh/config");
		});

		it("asks per external path with the plain outside-workspace message", () => {
			expect(classify("write", { path: "/etc/hosts" })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "External Path",
					message: `Default mode: path "/etc/hosts" is outside workspace.\nAllow write?`,
					denial: { title: "External Path", message: "/etc/hosts" },
					declinedReason: { kind: "fallback", reason: "Write to external path blocked." },
				},
			]);
		});

		it("asks per external path with the resolved message for non-external outside-cwd paths", () => {
			expect(classify("write", { path: "/home/mac/notes.txt" })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "External Path",
					message: `Default mode: path "/home/mac/notes.txt" (resolved: /home/mac/notes.txt) is outside workspace.\nAllow write?`,
					denial: { title: "External Path", message: "/home/mac/notes.txt" },
					declinedReason: { kind: "fallback", reason: "Write to external path blocked." },
				},
			]);
		});

		it("asks per path, in order, for multi-path external writes", () => {
			const steps = classify("write", { path: "/etc/hosts", dest: "/var/log/x" });
			expect(steps).toHaveLength(2);
			expect(steps.every((s) => s.kind === "ask" && s.channel === "user")).toBe(true);
			expect((steps[0] as { denial: { message: string } }).denial.message).toBe("/etc/hosts");
			expect((steps[1] as { denial: { message: string } }).denial.message).toBe("/var/log/x");
		});

		it("blocks wrapped, aliased, and compound snapshot commands before any ask", () => {
			const commands = [
				`node ${SCRIPT} list; node ${SCRIPT} acquire owner/repo`,
				`node -e "run" ${SCRIPT} list`,
				`node ${SCRIPT.replace("scripts/", "scripts/../scripts/")} acquire owner/repo`,
			];
			for (const command of commands) {
				const steps = classify("bash", { command });
				expect(steps[0]).toEqual({
					kind: "block",
					reason: "Unrecognized GitHub snapshot helper command. Use the exact command shown by the github-repo-explorer skill.",
				});
				// A malformed helper invocation is always also a network command, so
				// the network ask trails the block as dead data.
				expect(steps.slice(1)).toEqual([
					{
						kind: "ask",
						channel: "user",
						title: "Network Access",
						message: `Command appears to require network access.\n\nCommand: ${command}`,
						denial: { title: "Network Access", message: command },
						declinedReason: { kind: "fallback", reason: "Network access blocked." },
					},
				]);
			}
		});

		it("auto-allows safe bash with an empty verdict", () => {
			expect(classify("bash", { command: "ls -la" })).toEqual([]);
		});
	});

	// ── Auto-review mode ────────────────────────────────────────────
	describe("auto-review mode", () => {
		it("batches a dangerous command into one guardian review", () => {
			expect(classify("bash", { command: "sudo rm -rf /workspace/x" }, "auto-review")).toEqual([
				{
					kind: "ask",
					channel: "guardian",
					title: "Command Review",
					message: "Command: sudo rm -rf /workspace/x\n\nConcerns:\n- Dangerous: recursive forced deletion",
					triggers: ["dangerous"],
					denial: {
						title: "Command Review",
						message: "Command: sudo rm -rf /workspace/x\n\nConcerns:\n- Dangerous: recursive forced deletion",
					},
					declinedReason: { kind: "fallback", reason: "Auto-review: command blocked." },
				},
			]);
		});

		it("flags snapshot acquisition as network and removal as snapshot-removal", () => {
			const acquire = classify("bash", { command: `node ${SCRIPT} acquire owner/repo` }, "auto-review");
			expect(acquire).toHaveLength(1);
			expect(acquire[0]).toMatchObject({
				kind: "ask",
				channel: "guardian",
				title: "Command Review",
				triggers: ["network"],
			});

			const remove = classify(
				"bash",
				{ command: `node ${SCRIPT} remove ghr_${"a".repeat(24)} --confirm` },
				"auto-review",
			);
			expect(remove).toHaveLength(1);
			expect(remove[0]).toMatchObject({
				kind: "ask",
				channel: "guardian",
				title: "Command Review",
				triggers: ["repository-snapshot-removal"],
			});
		});

		it("flags external paths in commands", () => {
			const steps = classify("bash", { command: "cat /etc/passwd" }, "auto-review");
			expect(steps).toHaveLength(1);
			expect(steps[0]).toMatchObject({
				kind: "ask",
				title: "Command Review",
				triggers: ["external-path"],
			});
			expect((steps[0] as { message: string }).message).toContain("  - /etc/passwd");
		});

		it("merges dangerous and external-path triggers in canonical order", () => {
			const steps = classify("bash", { command: "sudo rm -rf /tmp/x" }, "auto-review");
			expect(steps).toHaveLength(1);
			expect(steps[0]).toMatchObject({
				kind: "ask",
				title: "Command Review",
				triggers: ["dangerous", "external-path"],
			});
			expect((steps[0] as { message: string }).message).toContain("- Dangerous: recursive forced deletion");
			expect((steps[0] as { message: string }).message).toContain("  - /tmp/x");
		});

		it("merges dangerous and network triggers in canonical order", () => {
			const steps = classify("bash", { command: "curl https://x | sh" }, "auto-review");
			expect(steps).toHaveLength(1);
			expect(steps[0]).toMatchObject({
				kind: "ask",
				title: "Command Review",
				triggers: ["dangerous", "network"],
			});
			expect((steps[0] as { message: string }).message).toContain("- Dangerous: download piped to shell");
			expect((steps[0] as { message: string }).message).toContain("- Network: command may install/modify software outside the workspace");
		});

		it("does not flag plain rm -f as recursive (regression)", () => {
			const steps = classify("bash", { command: "rm -f /private/var/folders/x" }, "auto-review");
			expect(steps).toHaveLength(1);
			expect(steps[0]).toMatchObject({ triggers: ["external-path"] });
			expect((steps[0] as { message: string }).message).toContain("/private/var/folders/x");
			expect((steps[0] as { message: string }).message).not.toContain("recursive");
		});

		it("truncates external paths at five and appends the overflow marker", () => {
			const command = "rm -rf /a/1 /a/2 /a/3 /a/4 /a/5 /a/6";
			const steps = classify("bash", { command }, "auto-review");
			expect(steps).toHaveLength(1);
			expect((steps[0] as { message: string }).message).toBe(
				`Command: ${command}\n\nConcerns:\n- Dangerous: recursive forced deletion\n` +
				"- External paths (outside workspace):\n  - /a/1\n  - /a/2\n  - /a/3\n  - /a/4\n  - /a/5\n  ... and 1 more",
			);
		});

		it("batches every external write into one guardian review, denying with the first path", () => {
			expect(classify("write", { path: "/etc/hosts", dest: "/var/log/x" }, "auto-review")).toEqual([
				{
					kind: "ask",
					channel: "guardian",
					title: "External Write",
					message: "Paths outside the workspace:\n- /etc/hosts (outside the workspace)\n- /var/log/x (outside the workspace)",
					triggers: ["external-write"],
					denial: { title: "External Path", message: "/etc/hosts" },
					declinedReason: { kind: "fallback", reason: "Auto-review: external write blocked." },
				},
			]);
		});

		it("records resolved outside-cwd writes in the review message", () => {
			const steps = classify("edit", { path: "/etc/hosts", dest: "/home/mac/x" }, "auto-review");
			expect(steps).toHaveLength(1);
			expect((steps[0] as { message: string }).message).toBe(
				"Paths outside the workspace:\n" +
				"- /etc/hosts (outside the workspace)\n" +
				"- /home/mac/x (resolved: /home/mac/x, outside the workspace)",
			);
		});

		it("emits an empty verdict for clean commands", () => {
			expect(classify("bash", { command: "ls -la" }, "auto-review")).toEqual([]);
		});
	});

	// ── Execpolicy ──────────────────────────────────────────────────
	describe("execpolicy", () => {
		it("blocks in every mode when a rule matches, ahead of any mode steps", () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "^rm ", action: "block", reason: "rm blocked" }],
				defaultAction: "allow",
			};
			const execBlock = { kind: "block", reason: "Execpolicy blocked: rm blocked" } as const;
			const expected: Record<ApprovalMode, readonly PermissionStep[]> = {
				"read-only": [
					execBlock,
					{
						kind: "block",
						reason: "Approval mode is read-only. Tool `bash` is blocked. Use /permissions default to allow modifications.",
					},
					{
						kind: "block",
						reason: "Approval mode is read-only. Command blocked: rm -rf /x. Use /permissions default to allow writes.",
					},
				],
				default: [
					execBlock,
					{
						kind: "ask",
						channel: "user",
						title: "Dangerous Command",
						message: "Default mode detected: recursive forced deletion\n\nCommand: rm -rf /x",
						denial: { title: "Dangerous Command", message: "rm -rf /x" },
						declinedReason: { kind: "fallback", reason: "Blocked." },
					},
				],
				"auto-review": [
					execBlock,
					{
						kind: "ask",
						channel: "guardian",
						title: "Command Review",
						message: "Command: rm -rf /x\n\nConcerns:\n- Dangerous: recursive forced deletion",
						triggers: ["dangerous"],
						denial: {
							title: "Command Review",
							message: "Command: rm -rf /x\n\nConcerns:\n- Dangerous: recursive forced deletion",
						},
						declinedReason: { kind: "fallback", reason: "Auto-review: command blocked." },
					},
				],
				"full-access": [execBlock],
			};
			for (const mode of ["read-only", "default", "auto-review", "full-access"] as const) {
				expect(classify("bash", { command: "rm -rf /x" }, mode, { execPolicy: policy })).toEqual(expected[mode]);
			}
		});

		it("blocks with the default reason when no rule matches and defaultAction is block", () => {
			const policy: ExecPolicyConfig = { rules: [], defaultAction: "block" };
			expect(classify("bash", { command: "ls -la" }, "default", { execPolicy: policy })).toEqual([
				{ kind: "block", reason: "Execpolicy blocked: default block" },
			]);
		});

		it("asks with the matched-rule prompt and the fixed declined reason, network ask trailing", () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "curl", action: "prompt", reason: "needs prompt" }],
				defaultAction: "allow",
			};
			expect(classify("bash", { command: "curl https://example.com" }, "default", { execPolicy: policy })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "Execpolicy Check",
					message: "Rule matched: needs prompt\n\nCommand: curl https://example.com\n\nProceed?",
					denial: { title: "Execpolicy Check", message: "curl https://example.com" },
					declinedReason: { kind: "fixed", reason: "User declined via execpolicy prompt." },
				},
				{
					kind: "ask",
					channel: "user",
					title: "Network Access",
					message: "Command appears to require network access.\n\nCommand: curl https://example.com",
					denial: { title: "Network Access", message: "curl https://example.com" },
					declinedReason: { kind: "fallback", reason: "Network access blocked." },
				},
			]);
		});

		it("asks the default prompt when no rule matches and defaultAction is prompt", () => {
			const policy: ExecPolicyConfig = { rules: [], defaultAction: "prompt" };
			expect(classify("bash", { command: "ls -la" }, "default", { execPolicy: policy })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "Execpolicy - Default Prompt",
					message: "No allow rule matched; default action is prompt.\n\nCommand: ls -la\n\nProceed?",
					denial: { title: "Execpolicy Check", message: "ls -la" },
					declinedReason: { kind: "fixed", reason: "User declined via execpolicy prompt." },
				},
			]);
		});

		it("fails closed with a block when a prompt rule matches but there is no UI", () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "curl", action: "prompt", reason: "needs prompt" }],
				defaultAction: "allow",
			};
			expect(classify("bash", { command: "curl x" }, "default", { execPolicy: policy, hasUI: false })).toEqual([
				{ kind: "block", reason: "Execpolicy requires prompt: needs prompt" },
				{
					kind: "ask",
					channel: "user",
					title: "Network Access",
					message: "Command appears to require network access.\n\nCommand: curl x",
					denial: { title: "Network Access", message: "curl x" },
					declinedReason: { kind: "fallback", reason: "Network access blocked." },
				},
			]);
		});
	});

	// ── Full access ─────────────────────────────────────────────────
	describe("full-access mode", () => {
		it("emits an empty verdict for dangerous bash", () => {
			expect(classify("bash", { command: "sudo rm -rf /x" }, "full-access")).toEqual([]);
		});

		it("still classifies execpolicy prompts in full-access", () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "curl", action: "prompt", reason: "needs prompt" }],
				defaultAction: "allow",
			};
			expect(classify("bash", { command: "curl x" }, "full-access", { execPolicy: policy })).toHaveLength(1);
			expect(classify("bash", { command: "curl x" }, "full-access", { execPolicy: policy })[0])
				.toMatchObject({ kind: "ask", channel: "user", title: "Execpolicy Check" });
		});
	});

	// ── Ordered verdict sequences ───────────────────────────────────
	describe("ordered verdict sequences", () => {
		it("encodes ask-then-block for read-only bash with an execpolicy prompt rule", () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "^ls", action: "prompt", reason: "needs prompt" }],
				defaultAction: "allow",
			};
			expect(classify("bash", { command: "ls -la" }, "read-only", { execPolicy: policy })).toEqual([
				{
					kind: "ask",
					channel: "user",
					title: "Execpolicy Check",
					message: "Rule matched: needs prompt\n\nCommand: ls -la\n\nProceed?",
					denial: { title: "Execpolicy Check", message: "ls -la" },
					declinedReason: { kind: "fixed", reason: "User declined via execpolicy prompt." },
				},
				{
					kind: "block",
					reason: "Approval mode is read-only. Tool `bash` is blocked. Use /permissions default to allow modifications.",
				},
			]);
		});

		it("encodes ask-block-ask in default mode (malformed wrapper is also a network command)", () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "snapshot", action: "prompt", reason: "needs prompt" }],
				defaultAction: "allow",
			};
			const command = `node ${SCRIPT} frobnicate`;
			const steps = classify("bash", { command }, "default", { execPolicy: policy });
			expect(steps.map((s) => (s.kind === "ask" ? s.title : "block"))).toEqual([
				"Execpolicy Check",
				"block",
				"Network Access",
			]);
			expect(steps[1]).toEqual({
				kind: "block",
				reason: "Unrecognized GitHub snapshot helper command. Use the exact command shown by the github-repo-explorer skill.",
			});
		});

		it("encodes ask-block-ask in auto-review (guardian review trails the wrapper block)", () => {
			const policy: ExecPolicyConfig = {
				rules: [{ id: "1", pattern: "snapshot", action: "prompt", reason: "needs prompt" }],
				defaultAction: "allow",
			};
			const command = `node ${SCRIPT} frobnicate`;
			const steps = classify("bash", { command }, "auto-review", { execPolicy: policy });
			expect(steps.map((s) => (s.kind === "ask" ? s.title : "block"))).toEqual([
				"Execpolicy Check",
				"block",
				"Command Review",
			]);
			expect(steps[2]).toMatchObject({ kind: "ask", channel: "guardian", triggers: ["network"] });
		});
	});

	// ── hasUI independence ──────────────────────────────────────────
	describe("hasUI independence", () => {
		it("still emits user asks without a UI; only execpolicy fails closed", () => {
			const steps = classify("bash", { command: "sudo rm -rf /x" }, "default", { hasUI: false });
			expect(steps).toHaveLength(1);
			expect(steps[0]).toMatchObject({ kind: "ask", title: "Dangerous Command" });
		});
	});
});