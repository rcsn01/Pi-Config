import { describe, expect, it, vi } from "vitest";
import {
	actionLabels,
	activePlanningEntry,
	assistantWithPlan,
	createHarness,
	createProfileDependencies,
	deferred,
	initializeAndExtract,
	normalModel,
} from "./test-harness.ts";

describe("simple plan review UI", () => {
	it("makes reconstructed inactive state explicit in the system prompt", async () => {
		const harness = createHarness({
			branch: [{
				type: "custom",
				customType: "plan-mode-state",
				data: { mode: "default", revision: 7, changedAt: "2026-01-01T00:00:00.000Z" },
			}],
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });

		const [result] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(result.systemPrompt).toContain("BASE");
		expect(result.systemPrompt).toContain("The final runtime mode marker is authoritative");
		expect(result.systemPrompt).toContain('<runtime mode="default" revision="7"/>');
		expect(result.systemPrompt).not.toContain("You are in **Plan Mode**");
	});

	it("ignores a stale persisted mode transition with a lower revision", async () => {
		const harness = createHarness({
			branch: [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { mode: "plan", revision: 8, changedAt: "2026-01-01T00:00:00.000Z" },
				},
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { mode: "default", revision: 7, changedAt: "2026-01-01T00:00:01.000Z" },
				},
			],
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });

		const [result] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(result.systemPrompt).toContain('<runtime mode="plan" revision="8"/>');
		expect(harness.getActiveToolNames()).toContain("plan_bash");
	});

	it("keeps runtime revisions monotonic across branch reconstruction", async () => {
		const harness = createHarness({
			branch: [{
				type: "custom",
				customType: "plan-mode-state",
				data: { mode: "plan", revision: 8, changedAt: "2026-01-01T00:00:00.000Z" },
			}],
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		harness.setBranch([{
			type: "custom",
			customType: "plan-mode-state",
			data: { mode: "default", revision: 3, changedAt: "2026-01-01T00:00:01.000Z" },
		}]);

		await harness.emit("session_tree", { type: "session_tree" });
		const [result] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(result.systemPrompt).toContain('<runtime mode="default" revision="9"/>');
	});

	it("clears plan content when a newer state omits it", async () => {
		const harness = createHarness({
			branch: [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: {
						mode: "plan", revision: 1, changedAt: "2026-01-01T00:00:00.000Z",
						phase: "awaiting_review", latestPlan: "# Obsolete Plan", latestPlanSignature: "old",
					},
				},
				{
					type: "custom",
					customType: "plan-mode-state",
					data: {
						mode: "plan", revision: 2, changedAt: "2026-01-01T00:00:01.000Z", phase: "planning",
					},
				},
			],
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.commands.get("plan").handler("show", harness.ctx);

		expect(harness.notify).toHaveBeenCalledWith("No proposed plan is available yet.", "warning");
		expect(harness.appendedEntries.some((entry) => entry.customType === "proposed-plan-display")).toBe(false);
	});

	it("treats a durable legacy proposed-plan message as already reviewed", async () => {
		const harness = createHarness({
			branch: [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { active: true, phase: "awaiting_review", setAt: 1 },
				},
				{
					type: "custom_message",
					customType: "proposed-plan",
					content: "# Legacy Durable Plan",
					details: {},
				},
			],
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("agent_settled");

		expect(harness.select).not.toHaveBeenCalled();
	});

	it("keeps the finalized plan in chat before opening Pi's built-in selector", async () => {
		const plan = "# Exact Plan\n\n1. First\n2. Second";
		const harness = createHarness();
		const [result] = await initializeAndExtract(harness, plan);

		expect(result.message.content[0].text).toContain(plan);
		expect(result.message.content[0].text).not.toContain("<proposed_plan>");
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.select).not.toHaveBeenCalled();
		await harness.emit("agent_end", { type: "agent_end", messages: [] });
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.select).not.toHaveBeenCalled();

		await harness.emit("agent_settled");
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(actionLabels.slice(0, 2)).toEqual([
			"Clear context and implement (recommended)",
			"Implement in current session",
		]);
		expect(harness.commands.get("plan").getArgumentCompletions("").slice(0, 3))
			.toEqual([
				{ value: "fresh", label: "fresh" },
				{ value: "implement", label: "implement" },
				{ value: "accept", label: "accept" },
			]);
		expect(harness.select).toHaveBeenCalledWith(expect.stringContaining("A proposed plan is ready for review."), actionLabels);
		expect(harness.timeline.at(-1)).toBe("select");
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.renderers.has("proposed-plan")).toBe(true);
		expect(harness.entryRenderers.has("proposed-plan-display")).toBe(true);
	});

	it("keeps only the last complete plan block when the model emits replacements", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const [result] = await harness.emit("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{
					type: "text",
					text: "<proposed_plan>Old plan</proposed_plan>\n<proposed_plan>Final plan</proposed_plan>",
				}],
			},
		});

		expect(result.message.content[0].text).toBe("Final plan");
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({ latestPlan: "Final plan" });
	});

	it("shows the current plan with a transcript-only entry", async () => {
		const plan = "# Show Me";
		const harness = createHarness();
		await initializeAndExtract(harness, plan);
		await harness.commands.get("plan").handler("show", harness.ctx);

		expect(harness.appendedEntries.at(-1)).toEqual({
			customType: "proposed-plan-display",
			data: expect.objectContaining({ content: plan }),
		});
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("implements the current plan with an explicit system-level Plan Mode exit", async () => {
		const plan = "# Implement Me";
		const harness = createHarness({ selection: "Implement in current session" });
		await initializeAndExtract(harness, plan);

		const [activePrompt] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(activePrompt.systemPrompt).toContain("You are in **Plan Mode**");

		await harness.emit("agent_settled");

		expect(harness.sendUserMessage).toHaveBeenCalledWith(`Implement this proposed plan:\n\n${plan}`, undefined);
		expect(harness.setEditorText).not.toHaveBeenCalled();
		const [implementationPrompt] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(implementationPrompt.systemPrompt).toContain('<runtime mode="default" revision="2"/>');
		expect(implementationPrompt.systemPrompt).not.toContain("You are in **Plan Mode**");
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({
			mode: "default",
			revision: 2,
			changedAt: expect.any(String),
		});
	});

	it("starts a fresh implementation automatically and preserves the session profile", async () => {
		const harness = createHarness({
			selection: "Clear context and implement (recommended)",
			branch: [
				activePlanningEntry(),
				{ type: "custom", customType: "configProfiles", data: { active: "focused" } },
			],
		});
		await initializeAndExtract(harness, "# Fresh Plan");
		await harness.emit("agent_settled");

		expect(harness.timeline).toContain("submit:/plan-implement-fresh");
		expect(harness.newSession).toHaveBeenCalledTimes(1);
		expect(harness.freshAppendCustomEntry).toHaveBeenCalledWith("configProfiles", { active: "focused" });
		expect(harness.freshSendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Implement the plan in a fresh context"),
		);
		expect(harness.freshSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("# Fresh Plan"));
		expect(harness.setEditorText).not.toHaveBeenCalled();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("restores Plan Mode and the reviewed plan when fresh-session creation is cancelled", async () => {
		const stores = createProfileDependencies();
		const harness = createHarness({
			selection: "Clear context and implement (recommended)",
			newSessionCancelled: true,
			model: normalModel,
			availableModels: [normalModel],
			dependencies: stores.dependencies,
		});
		await initializeAndExtract(harness, "# Restore After Cancellation");
		await harness.emit("agent_settled");

		expect(harness.newSession).toHaveBeenCalledOnce();
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({
			mode: "plan",
			phase: "awaiting_review",
			latestPlan: "# Restore After Cancellation",
			promptedPlanSignature: expect.any(String),
		});
		expect(harness.notify).toHaveBeenCalledWith(
			"Fresh implementation session cancelled. Plan mode restored.",
			"info",
		);
		const [prompt] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(prompt.systemPrompt).toContain('<runtime mode="plan" revision="3"/>');
	});

	it("falls back to prefilling the command when automatic submission is unavailable", async () => {
		const harness = createHarness({
			selection: "Clear context and implement (recommended)",
			editorSubmitAvailable: false,
		});
		await initializeAndExtract(harness, "# Fallback Plan");
		await harness.emit("agent_settled");

		expect(harness.newSession).not.toHaveBeenCalled();
		expect(harness.setEditorText).toHaveBeenCalledWith("/plan-implement-fresh");
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("Automatic command submission was unavailable"),
			"warning",
		);
	});

	it("invalidates a deferred fresh implementation when Plan Mode is entered again", async () => {
		const stores = createProfileDependencies();
		const harness = createHarness({
			selection: "Clear context and implement (recommended)",
			editorSubmitAvailable: false,
			model: normalModel,
			availableModels: [normalModel],
			dependencies: stores.dependencies,
		});
		await initializeAndExtract(harness, "# Deferred Fresh Plan");
		await harness.emit("agent_settled");
		expect(harness.setEditorText).toHaveBeenCalledWith("/plan-implement-fresh");
		expect(harness.newSession).not.toHaveBeenCalled();
		harness.newSession.mockClear();

		await harness.commands.get("plan").handler("", harness.ctx);
		await harness.commands.get("plan-implement-fresh").handler("", { ...harness.ctx, newSession: harness.newSession });

		expect(harness.newSession).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("No proposed plan is available for fresh implementation.", "warning");
	});

	it("collects revision feedback when selected", async () => {
		const harness = createHarness({
			selection: "Revise current plan",
			editorResult: "Use the simpler API",
		});
		await initializeAndExtract(harness, "# Revise Me");
		await harness.emit("agent_settled");

		expect(harness.editor).toHaveBeenCalledWith("What should Pi do differently?", "");
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Feedback:\nUse the simpler API"),
			undefined,
		);
	});

	it.each(["Stay in Plan Mode", undefined] as const)("keeps Plan Mode active after %s", async (selection) => {
		const harness = createHarness({ selection });
		await initializeAndExtract(harness, "# Stay Here");
		await harness.emit("agent_settled");

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.setEditorText).not.toHaveBeenCalled();
		expect(harness.editor).not.toHaveBeenCalled();
		const persistedStates = harness.appendedEntries
			.filter((entry) => entry.customType === "plan-mode-state")
			.map((entry) => entry.data);
		expect(persistedStates.at(-1)).toMatchObject({ mode: "plan", phase: "awaiting_review" });
	});
});

describe("context-aware review recommendation", () => {
	it("shows context usage and recommends fresh implementation above the threshold", async () => {
		const harness = createHarness({
			contextUsage: { tokens: 600_000, contextWindow: 1_000_000, percent: 60 },
		});
		await initializeAndExtract(harness, "# High Usage Plan");
		await harness.emit("agent_settled");

		expect(harness.select).toHaveBeenCalledWith(
			expect.stringContaining("Context: 60% used (600K / 1M tokens)"),
			[
				"Clear context and implement (recommended)",
				"Implement in current session",
				"Revise current plan",
				"Stay in Plan Mode",
			],
		);
	});

	it("shows context usage and recommends implementing in the current session at or below the threshold", async () => {
		const harness = createHarness({
			contextUsage: { tokens: 200_000, contextWindow: 1_000_000, percent: 20 },
		});
		await initializeAndExtract(harness, "# Low Usage Plan");
		await harness.emit("agent_settled");

		expect(harness.select).toHaveBeenCalledWith(
			expect.stringContaining("Context: 20% used (200K / 1M tokens)"),
			[
				"Clear context and implement",
				"Implement in current session (recommended)",
				"Revise current plan",
				"Stay in Plan Mode",
			],
		);
	});

	it("falls back to fresh recommendation without a usage line when context usage is unknown", async () => {
		const harness = createHarness({
			contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null },
		});
		await initializeAndExtract(harness, "# Unknown Usage Plan");
		await harness.emit("agent_settled");

		expect(harness.select).toHaveBeenCalledWith(
			expect.not.stringContaining("Context:"),
			[
				"Clear context and implement (recommended)",
				"Implement in current session",
				"Revise current plan",
				"Stay in Plan Mode",
			],
		);
	});

	it("implements in the current session when the recommended low-usage action is selected", async () => {
		const plan = "# Low Usage Implement";
		const harness = createHarness({
			contextUsage: { tokens: 100_000, contextWindow: 1_000_000, percent: 10 },
			selection: "Implement in current session (recommended)",
		});
		await initializeAndExtract(harness, plan);
		await harness.emit("agent_settled");

		expect(harness.sendUserMessage).toHaveBeenCalledWith(`Implement this proposed plan:\n\n${plan}`, undefined);
	});
});

describe("plan review lifecycle", () => {
	it("does not prompt twice for duplicate settlement but prompts for a revised signature", async () => {
		const harness = createHarness();
		await initializeAndExtract(harness, "# Plan One\n\nFirst version");
		await harness.emit("agent_settled");
		await harness.emit("agent_settled");
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.select).toHaveBeenCalledTimes(1);

		const revised = "# Plan Two\n\nMaterially revised version";
		await harness.emit("message_end", { type: "message_end", message: assistantWithPlan(revised) });
		await harness.emit("agent_settled");
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.select).toHaveBeenCalledTimes(2);
		expect(harness.custom).not.toHaveBeenCalled();
	});

	it("re-prompts for ambiguous or repeated input without injecting the plan into model context", async () => {
		const plan = "# Current Plan\n\nKeep this exact proposal.";
		const harness = createHarness();
		await initializeAndExtract(harness, plan);
		await harness.emit("agent_settled");

		const ambiguous = await harness.emit("input", {
			type: "input",
			text: "continue",
			source: "interactive",
		});
		expect(harness.timeline.at(-1)).toBe("select");

		const repeated = await harness.emit("input", {
			type: "input",
			text: plan,
			source: "interactive",
		});
		expect(harness.timeline.at(-1)).toBe("select");

		expect(ambiguous).toEqual([{ action: "handled" }]);
		expect(repeated).toEqual([{ action: "handled" }]);
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.select).toHaveBeenCalledTimes(3);
		expect(harness.custom).not.toHaveBeenCalled();
	});

	it("does not execute a reviewed plan after the mode changes while the selector is open", async () => {
		const selection = deferred<string | undefined>();
		const harness = createHarness({ selectionPromise: selection.promise });
		await initializeAndExtract(harness, "# Plan That Becomes Stale");

		const review = harness.emit("agent_settled");
		await vi.waitFor(() => expect(harness.select).toHaveBeenCalledOnce());
		await harness.commands.get("plan").handler("exit", harness.ctx);
		selection.resolve("Implement in current session");
		await review;

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("No action was taken"), "warning");
	});

	it("does not send revision feedback after the mode changes while the editor is open", async () => {
		const feedback = deferred<string | undefined>();
		const harness = createHarness({ editorPromise: feedback.promise });
		await initializeAndExtract(harness, "# Plan With Pending Feedback");

		const revision = harness.commands.get("plan").handler("revise", harness.ctx);
		await vi.waitFor(() => expect(harness.editor).toHaveBeenCalledOnce());
		await harness.commands.get("plan").handler("exit", harness.ctx);
		feedback.resolve("Apply obsolete feedback");
		await revision;

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("No feedback was sent"), "warning");
	});

	it("keeps the plan in the assistant message but never opens approval UI outside TUI mode", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as any);
		try {
			const harness = createHarness({ mode: "print" });
			await initializeAndExtract(harness, "# Non-TUI Plan\n\nRun explicitly.");
			await harness.emit("agent_settled");
			await harness.emit("agent_settled");

			expect(harness.sendMessage).not.toHaveBeenCalled();
			expect(harness.select).not.toHaveBeenCalled();
			expect(harness.custom).not.toHaveBeenCalled();
			expect(stderr).toHaveBeenCalledTimes(1);
			expect(String(stderr.mock.calls[0]?.[0])).toContain(
				"Use /plan fresh (recommended), /plan implement, /plan revise, or /plan show.",
			);
		} finally {
			stderr.mockRestore();
		}
	});

	it("reconstructs a prompted plan without reopening it after reload or branch navigation", async () => {
		const plan = "# Durable Plan\n\nPersist me.";
		const branch = [
			{
				type: "custom",
				customType: "plan-mode-state",
				data: {
					active: true,
					phase: "awaiting_review",
					setAt: 1,
					latestPlan: plan,
					latestPlanSignature: "durable-signature",
					promptedPlanSignature: "durable-signature",
				},
			},
		];
		const harness = createHarness({ branch });
		await harness.emit("session_start", { type: "session_start", reason: "reload" });
		await harness.emit("agent_settled");
		await harness.emit("session_tree", { type: "session_tree" });
		await harness.emit("agent_settled");

		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.select).not.toHaveBeenCalled();
		expect(harness.custom).not.toHaveBeenCalled();
	});

	it("shows only the Plan Mode phase in the bottom status bar", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.setStatus).toHaveBeenCalledWith("plan", "plan");

		await initializeAndExtract(harness, "# Status Bar Plan");
		await harness.emit("turn_end");
		expect(harness.setStatus).toHaveBeenLastCalledWith("plan", "plan review");
		expect(harness.setStatus.mock.calls.flat().join(" ")).not.toContain("/");
	});
});

