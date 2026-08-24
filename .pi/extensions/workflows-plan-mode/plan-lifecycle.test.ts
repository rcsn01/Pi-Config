import { describe, expect, it, vi } from "vitest";
import planModeExtension, {
	createPlanModeExtension,
	PLAN_REVIEW_ACTIONS,
} from "./index.ts";
import type { ModeModelProfile } from "./model-profile.ts";
import {
	activePlanningEntry,
	createHarness,
	createProfileDependencies,
	deferred,
	normalModel,
	profileFor,
} from "./test-harness.ts";

describe("Plan Mode tool policy integration", () => {
	it("preserves the public entrypoint and Pi registration interfaces in order", () => {
		const harness = createHarness();
		expect(planModeExtension).toEqual(expect.any(Function));
		expect(createPlanModeExtension).toEqual(expect.any(Function));
		expect(PLAN_REVIEW_ACTIONS.map((action) => action.value)).toEqual([
			"fresh", "implement", "revise", "stay",
		]);
		expect(harness.registrations).toEqual([
			"tool:plan_bash",
			"message-renderer:proposed-plan",
			"entry-renderer:proposed-plan-display",
			"event:session_start",
			"event:session_tree",
			"event:session_shutdown",
			"event:model_select",
			"event:thinking_level_select",
			"event:input",
			"event:turn_end",
			"event:before_agent_start",
			"event:message_end",
			"event:agent_settled",
			"event:tool_call",
			"command:plan-implement-fresh",
			"shortcut:shift+tab",
			"command:plan",
		]);
		expect(harness.tools.get("plan_bash")).toMatchObject({
			name: "plan_bash",
			label: "Plan Bash (isolated)",
			promptSnippet: "Execute arbitrary checks in an isolated disposable workspace",
		});
		expect(harness.commands.get("plan-implement-fresh").description)
			.toBe("Implement the latest proposed plan in a fresh session");
		expect(harness.shortcuts.get("shift+tab").description).toBe("Toggle plan mode");
		expect(harness.commands.get("plan").getArgumentCompletions("")).toEqual(
			["fresh", "implement", "accept", "revise ", "show", "refresh", "status", "exit"]
				.map((value) => ({ value, label: value })),
		);
	});

	it("passes the resolved Session profile path before Plan Mode reconstruction", async () => {
		const stores = createProfileDependencies();
		const harness = createHarness({
			branch: [
				activePlanningEntry(),
				{ type: "custom", customType: "configProfiles", data: { active: "focused" } },
			],
			model: normalModel,
			availableModels: [normalModel],
			dependencies: stores.dependencies,
		});

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(stores.setPath).toHaveBeenCalledWith(expect.stringContaining("/profiles/focused.json"));
		expect(stores.setPath.mock.invocationCallOrder[0]).toBeLessThan(stores.capture.mock.invocationCallOrder[0]);
	});

	it("uses one monotonic runtime marker across repeated mode switches", async () => {
		const stores = createProfileDependencies();
		const harness = createHarness({
			branch: [], model: normalModel, availableModels: [normalModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		await harness.shortcuts.get("shift+tab").handler(harness.ctx);
		let [prompt] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(prompt.systemPrompt).toContain('<runtime mode="plan" revision="1"/>');

		await harness.shortcuts.get("shift+tab").handler(harness.ctx);
		[prompt] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(prompt.systemPrompt).toContain('<runtime mode="default" revision="2"/>');
		expect(prompt.systemPrompt.match(/<runtime mode=/g)).toHaveLength(1);

		await harness.shortcuts.get("shift+tab").handler(harness.ctx);
		[prompt] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(prompt.systemPrompt).toContain('<runtime mode="plan" revision="3"/>');
		expect(harness.appendedEntries
			.filter((entry) => entry.customType === "plan-mode-state")
			.map((entry) => entry.data.revision)).toEqual([1, 2, 3]);
	});

	it("aborts in-flight work and discards all content from an older mode revision", async () => {
		const pendingDispose = deferred<void>();
		const createSandbox = vi.fn(() => ({
			operations: { exec: vi.fn(async () => ({ exitCode: 0 })) },
			initialize: vi.fn(async () => {}),
			dispose: vi.fn(() => pendingDispose.promise),
		}));
		const harness = createHarness({ idle: false, dependencies: { createSandbox } });
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.tools.get("plan_bash").execute(
			"tool-prepare", { command: "pwd" }, undefined, undefined, harness.ctx,
		);
		expect(createSandbox).toHaveBeenCalledOnce();
		await harness.emit("before_agent_start", { systemPrompt: "BASE" });

		const exiting = harness.shortcuts.get("shift+tab").handler(harness.ctx);
		await vi.waitFor(() => expect(harness.abort).toHaveBeenCalledOnce());
		const [result] = await harness.emit("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "stale plan output" },
					{ type: "toolCall", id: "stale-tool", name: "write", arguments: { path: "stale" } },
				],
			},
		});
		expect(result.message.content).toEqual([{
			type: "text",
			text: expect.stringContaining("discarded because the runtime mode changed"),
		}]);

		let nextPromptSettled = false;
		const nextPrompt = harness.emit("before_agent_start", { systemPrompt: "BASE" }).then((results) => {
			nextPromptSettled = true;
			return results;
		});
		await Promise.resolve();
		expect(nextPromptSettled).toBe(false);

		pendingDispose.resolve();
		await exiting;
		const [promptResult] = await nextPrompt;
		expect(promptResult.systemPrompt).toContain('<runtime mode="default" revision="2"/>');
	});

	it("blocks host Bash only while Plan Mode is active", async () => {
		const active = createHarness();
		await active.emit("session_start", { type: "session_start", reason: "startup" });
		const [blocked] = await active.emit("tool_call", {
			type: "tool_call",
			toolName: "bash",
			input: { command: "rg foo; touch changed" },
		});
		expect(blocked).toEqual({
			block: true,
			reason: expect.stringContaining("Use plan_bash"),
		});

		const inactive = createHarness({ branch: [] });
		await inactive.emit("session_start", { type: "session_start", reason: "startup" });
		const [allowed] = await inactive.emit("tool_call", {
			type: "tool_call",
			toolName: "bash",
			input: { command: "touch changed" },
		});
		expect(allowed).toBeUndefined();
	});

	it("continues blocking non-Bash mutating tools while planning", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const [blocked] = await harness.emit("tool_call", {
			type: "tool_call", toolName: "write", input: { path: "file" },
		});
		expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("write is disabled") });
	});
});

describe("Plan Mode isolated Bash lifecycle", () => {
	it("installs the Plan Mode tool set before asynchronous profile capture", async () => {
		const pendingCapture = deferred<ModeModelProfile>();
		const capture = vi.fn(() => pendingCapture.promise);
		const harness = createHarness({
			model: normalModel,
			availableModels: [normalModel],
			dependencies: {
				normalDefaultsStore: {
					capture,
					restore: vi.fn(async () => {}),
				},
			},
		});

		const reconstruction = harness.emit("session_start", { type: "session_start", reason: "resume" });
		await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
		expect(harness.getActiveToolNames()).toContain("plan_bash");
		expect(harness.getActiveToolNames()).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));

		pendingCapture.resolve(profileFor(normalModel, "medium"));
		await reconstruction;
	});

	it("reconstructs active Plan Mode without creating a workspace", async () => {
		const createWorkspace = vi.fn();
		const harness = createHarness({
			model: normalModel,
			availableModels: [normalModel],
			dependencies: { createWorkspace },
		});

		await harness.emit("session_start", { type: "session_start", reason: "resume" });

		expect(createWorkspace).not.toHaveBeenCalled();
		expect(harness.getActiveToolNames()).toContain("plan_bash");
		expect(harness.setStatus).not.toHaveBeenCalledWith("plan-runtime", "⟳ sandbox");
	});

	it("activates without a workspace and makes the first plan_bash await preparation", async () => {
		const stores = createProfileDependencies();
		const pendingWorkspace = deferred<any>();
		const createWorkspace = vi.fn(() => pendingWorkspace.promise);
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel],
			dependencies: { ...stores.dependencies, createWorkspace },
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.shortcuts.get("shift+tab").handler(harness.ctx);

		expect(createWorkspace).not.toHaveBeenCalled();
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({ mode: "plan", revision: 1 });
		expect(harness.getActiveToolNames()).toContain("plan_bash");

		const execution = harness.tools.get("plan_bash").execute(
			"tool-1", { command: "pwd" }, undefined, undefined, harness.ctx,
		);
		await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalledOnce());
		expect(harness.setStatus).toHaveBeenCalledWith("plan-runtime", "⟳ sandbox");
		expect(harness.sandboxExec).not.toHaveBeenCalled();

		pendingWorkspace.resolve({
			root: "/tmp/plan",
			hostRoot: "/test/project",
			sandboxRoot: "/tmp/plan/project",
			tempRoot: "/tmp/plan/tmp",
			dispose: vi.fn(async () => {}),
		});
		await execution;
		expect(harness.sandboxExec).toHaveBeenCalledOnce();
		expect(harness.setStatus).toHaveBeenCalledWith("plan-runtime", undefined);
	});

	it("serializes branch reconstruction with an overlapping Plan Mode exit", async () => {
		const sandboxDisposals: Array<ReturnType<typeof vi.fn>> = [];
		const createWorkspace = vi.fn(async (hostRoot: string) => ({
			root: `/tmp/plan-${createWorkspace.mock.calls.length}`,
			hostRoot,
			sandboxRoot: `/tmp/plan-${createWorkspace.mock.calls.length}/project`,
			tempRoot: `/tmp/plan-${createWorkspace.mock.calls.length}/tmp`,
			dispose: vi.fn(async () => {}),
		}));
		const createSandbox = vi.fn(() => {
			const dispose = vi.fn(async () => {});
			sandboxDisposals.push(dispose);
			return {
				operations: { exec: vi.fn(async () => ({ exitCode: 0 })) },
				initialize: vi.fn(async () => {}),
				dispose,
			};
		});
		const harness = createHarness({
			model: normalModel,
			availableModels: [normalModel],
			dependencies: { createWorkspace, createSandbox },
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.tools.get("plan_bash").execute(
			"tool-prepare", { command: "pwd" }, undefined, undefined, harness.ctx,
		);
		expect(createWorkspace).toHaveBeenCalledTimes(1);

		const reconstruction = harness.emit("session_tree", { type: "session_tree" });
		const exiting = harness.shortcuts.get("shift+tab").handler(harness.ctx);
		await Promise.all([reconstruction, exiting]);

		expect(createWorkspace).toHaveBeenCalledTimes(1);
		expect(sandboxDisposals).toHaveLength(1);
		expect(sandboxDisposals[0]).toHaveBeenCalledOnce();
		expect(harness.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		await harness.commands.get("plan").handler("status", harness.ctx);
		expect(harness.notify).toHaveBeenLastCalledWith("Plan mode inactive.", "info");
	});

	it("shuts down without materializing an unused workspace", async () => {
		const stores = createProfileDependencies();
		let copySignal: AbortSignal | undefined;
		const createWorkspace = vi.fn((_root: string, options?: { signal?: AbortSignal }) => {
			copySignal = options?.signal;
			return new Promise<any>((_resolve, reject) => {
				copySignal?.addEventListener("abort", () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				}, { once: true });
			});
		});
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel],
			dependencies: { ...stores.dependencies, createWorkspace },
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.shortcuts.get("shift+tab").handler(harness.ctx);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(createWorkspace).not.toHaveBeenCalled();
		expect(copySignal).toBeUndefined();
		expect(harness.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
	});

	it("ignores repeated Shift+Tab while the same entry transition is in progress", async () => {
		const pendingProfile = deferred<ModeModelProfile | undefined>();
		const load = vi.fn(() => pendingProfile.promise);
		const stores = createProfileDependencies();
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel],
			dependencies: {
				...stores.dependencies,
				profileStore: { load, save: stores.save, setPath: vi.fn() },
			},
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const first = harness.shortcuts.get("shift+tab").handler(harness.ctx);
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
		const second = harness.shortcuts.get("shift+tab").handler(harness.ctx);
		await Promise.resolve();
		expect(load).toHaveBeenCalledOnce();

		pendingProfile.resolve(undefined);
		await Promise.all([first, second]);
		const activeEntries = harness.appendedEntries.filter(
			(entry) => entry.customType === "plan-mode-state" && entry.data.mode === "plan",
		);
		expect(activeEntries).toHaveLength(1);
	});

	it("routes arbitrary commands through plan_bash and restores the exact normal tools on exit", async () => {
		const stores = createProfileDependencies();
		const initialTools = ["read", "bash", "edit", "write", "grep", "custom_tool", "ask_user"];
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel], activeTools: initialTools,
			dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);

		expect(harness.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "grep", "custom_tool", "plan_bash", "ask_user"]));
		expect(harness.getActiveToolNames()).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));

		const planBash = harness.tools.get("plan_bash");
		await planBash.execute(
			"tool-1",
			{ command: `npm --prefix apps/Amove run test:e2e -- --grep "navigation"` },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(harness.sandboxExec).toHaveBeenCalledWith(
			expect.stringContaining("npm --prefix apps/Amove"),
			expect.any(String),
			expect.any(Object),
		);

		await harness.commands.get("plan").handler("exit", harness.ctx);
		expect(harness.getActiveToolNames()).toEqual(initialTools);
		expect(harness.sandboxDispose).toHaveBeenCalled();
		expect(harness.workspaceDispose).toHaveBeenCalled();
	});

	it("keeps reconstructed Plan Mode fail-closed when sandbox initialization fails", async () => {
		const harness = createHarness({
			model: normalModel,
			availableModels: [normalModel],
			sandboxInitializeError: new Error("sandbox unavailable"),
		});
		await harness.emit("session_start", { type: "session_start", reason: "reload" });

		expect(harness.getActiveToolNames()).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));
		expect(harness.getActiveToolNames()).toContain("plan_bash");
		await expect(harness.tools.get("plan_bash").execute(
			"tool-1", { command: "pytest" }, undefined, undefined, harness.ctx,
		)).rejects.toThrow("sandbox unavailable");
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("sandbox unavailable"), "error");
		const [blocked] = await harness.emit("tool_call", {
			type: "tool_call", toolName: "bash", input: { command: "pytest" },
		});
		expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("plan_bash") });
	});
});

describe("mode-change note", () => {
	it("notes Plan Mode entry and exit between turns and stays silent on stable mode", async () => {
		const stores = createProfileDependencies();
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const [first] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(first.systemPrompt).not.toContain("<mode_change_note>");

		await harness.commands.get("plan").handler("", harness.ctx);
		const [afterEnter] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(afterEnter.systemPrompt).toContain(
			"<mode_change_note>Plan Mode was entered since the previous turn.</mode_change_note>",
		);

		const [stable] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(stable.systemPrompt).not.toContain("<mode_change_note>");

		await harness.commands.get("plan").handler("exit", harness.ctx);
		const [afterExit] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(afterExit.systemPrompt).toContain(
			"<mode_change_note>Plan Mode was exited since the previous turn.</mode_change_note>",
		);
		expect(afterExit.systemPrompt).toContain('<runtime mode="default" revision="2"/>');
	});

	it("does not emit a spurious note after reconstruction", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const [before] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(before.systemPrompt).not.toContain("<mode_change_note>");

		await harness.emit("session_tree", { type: "session_tree" });
		const [after] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(after.systemPrompt).not.toContain("<mode_change_note>");
	});

	it("notes mode changes caused by tree navigation", async () => {
		const stores = createProfileDependencies();
		const stateEntry = (mode: "default" | "plan", revision: number) => ({
			type: "custom",
			customType: "plan-mode-state",
			data: {
				mode,
				revision,
				changedAt: "2026-01-01T00:00:00.000Z",
				...(mode === "plan" ? { phase: "planning" } : {}),
			},
		});
		const harness = createHarness({
			branch: [stateEntry("default", 1)],
			model: normalModel,
			thinkingLevel: "medium",
			availableModels: [normalModel],
			dependencies: stores.dependencies,
		});

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const [initial] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(initial.systemPrompt).not.toContain("<mode_change_note>");

		harness.setBranch([stateEntry("plan", 2)]);
		await harness.emit("session_tree", { type: "session_tree" });
		const [entered] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(entered.systemPrompt).toContain(
			"<mode_change_note>Plan Mode was entered since the previous turn.</mode_change_note>",
		);

		harness.setBranch([stateEntry("default", 3)]);
		await harness.emit("session_tree", { type: "session_tree" });
		const [exited] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(exited.systemPrompt).toContain(
			"<mode_change_note>Plan Mode was exited since the previous turn.</mode_change_note>",
		);
	});
});

