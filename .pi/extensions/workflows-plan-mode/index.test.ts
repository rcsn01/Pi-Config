import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import planModeExtension, {
	createPlanModeExtension,
	type PlanModeDependencies,
	PLAN_REVIEW_ACTIONS,
} from "./index.ts";
import {
	createNormalDefaultsStore,
	createPlanModeProfileStore,
	parsePlanModeProfileDocument,
	type ModeModelProfile,
	type PlanModeProfileStore,
} from "./model-profile.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => unknown;

interface HarnessOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	branch?: any[];
	selection?: string;
	editorResult?: string;
	editorSubmitAvailable?: boolean;
	model?: any;
	thinkingLevel?: ModelThinkingLevel;
	availableModels?: any[];
	setModelResult?: boolean;
	dependencies?: PlanModeDependencies;
}

function activePlanningEntry(): any {
	return {
		type: "custom",
		customType: "plan-mode-state",
		data: { active: true, phase: "planning", setAt: 1 },
	};
}

function assistantWithPlan(plan: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text: `Before\n<proposed_plan>\n${plan}\n</proposed_plan>\nAfter` }],
	};
}

function createHarness(options: HarnessOptions = {}) {
	const mode = options.mode ?? "tui";
	const branch = options.branch ?? [activePlanningEntry()];
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const renderers = new Map<string, any>();
	const entryRenderers = new Map<string, any>();
	const timeline: string[] = [];
	let currentModel = options.model;
	let thinkingLevel = options.thinkingLevel ?? "medium";
	const appendedEntries: Array<{ customType: string; data: any }> = [];

	const custom = vi.fn();
	const select = vi.fn(async () => {
		timeline.push("select");
		return options.selection;
	});
	const notify = vi.fn();
	const setStatus = vi.fn();
	const editor = vi.fn(async () => options.editorResult);
	const setEditorText = vi.fn();
	const freshSendUserMessage = vi.fn();
	const newSession = vi.fn(async (sessionOptions?: any) => {
		timeline.push("newSession");
		await sessionOptions?.withSession?.({ sendUserMessage: freshSendUserMessage });
		return { cancelled: false };
	});
	let currentEditorFactory: any;
	const getEditorComponent = vi.fn(() => currentEditorFactory);
	const setEditorComponent = vi.fn((factory?: any) => {
		currentEditorFactory = factory;
		if (!factory) return;
		const component = factory({}, {}, {});
		if (options.editorSubmitAvailable !== false) {
			component.onSubmit = async (text: string) => {
				timeline.push(`submit:${text}`);
				const spaceIndex = text.indexOf(" ");
				const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
				const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
				const command = commands.get(commandName);
				if (command) await command.handler(args, { ...ctx, newSession });
			};
		}
	});
	const ui = {
		custom,
		select,
		confirm: vi.fn(async () => false),
		input: vi.fn(async () => undefined),
		editor,
		notify,
		setStatus,
		setEditorText,
		getEditorComponent,
		setEditorComponent,
	} as any;
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: "/test/project",
		ui,
		get model() {
			return currentModel;
		},
		get thinkingLevel() {
			return thinkingLevel;
		},
		scopedModels: [],
		modelRegistry: {
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			find: vi.fn((provider: string, modelId: string) =>
				(options.availableModels ?? [currentModel]).find(
					(model) => model?.provider === provider && model.id === modelId,
				)),
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionFile: () => undefined,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;

	const sendMessage = vi.fn((message: any) => {
		timeline.push(`message:${message.customType}`);
	});
	const sendUserMessage = vi.fn(() => {
		timeline.push("sendUserMessage");
	});
	const appendEntry = vi.fn((customType: string, data: any) => {
		appendedEntries.push({ customType, data });
	});
	const setModel = vi.fn(async (model: any) => {
		timeline.push(`setModel:${model.provider}/${model.id}`);
		if (options.setModelResult === false) return false;
		const previousModel = currentModel;
		currentModel = model;
		for (const handler of handlers.get("model_select") ?? []) {
			await handler({ type: "model_select", model, previousModel, source: "set" }, ctx);
		}
		return true;
	});
	const setThinkingLevel = vi.fn((level: ModelThinkingLevel) => {
		timeline.push(`setThinking:${level}`);
		thinkingLevel = level;
	});
	const pi = {
		on: (event: string, handler: EventHandler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerTool: vi.fn(),
		registerMessageRenderer: (customType: string, renderer: any) => renderers.set(customType, renderer),
		registerEntryRenderer: (customType: string, renderer: any) => entryRenderers.set(customType, renderer),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerShortcut: (shortcut: string, definition: any) => shortcuts.set(shortcut, definition),
		appendEntry,
		sendMessage,
		sendUserMessage,
		setModel,
		getThinkingLevel: vi.fn(() => thinkingLevel),
		setThinkingLevel,
	} as unknown as ExtensionAPI;

	(options.dependencies ? createPlanModeExtension(options.dependencies) : planModeExtension)(pi);

	async function emit(event: string, payload: any = { type: event }): Promise<any[]> {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	}

	return {
		ctx,
		emit,
		commands,
		shortcuts,
		renderers,
		entryRenderers,
		timeline,
		appendedEntries,
		custom,
		select,
		notify,
		setStatus,
		editor,
		setEditorText,
		getEditorComponent,
		setEditorComponent,
		newSession,
		freshSendUserMessage,
		sendMessage,
		sendUserMessage,
		setModel,
		setThinkingLevel,
		setCurrentModel: (model: any) => {
			currentModel = model;
		},
		setCurrentThinkingLevel: (level: ModelThinkingLevel) => {
			thinkingLevel = level;
		},
	};
}

async function initializeAndExtract(harness: ReturnType<typeof createHarness>, plan: string): Promise<any[]> {
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	return harness.emit("message_end", { type: "message_end", message: assistantWithPlan(plan) });
}

const actionLabels = PLAN_REVIEW_ACTIONS.map((action) => action.label);

const normalModel = {
	provider: "anthropic",
	id: "claude-sonnet-4.6",
	name: "Claude Sonnet 4.6",
	contextWindow: 1_000_000,
	reasoning: true,
};
const planModel = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	contextWindow: 1_050_000,
	reasoning: true,
};

function profileFor(model: typeof normalModel, thinkingLevel: ModelThinkingLevel): ModeModelProfile {
	return { provider: model.provider, modelId: model.id, thinkingLevel, contextWindow: model.contextWindow };
}

function createProfileDependencies(initial?: ModeModelProfile) {
	let stored = initial;
	const load = vi.fn(async () => stored);
	const save = vi.fn(async (profile: ModeModelProfile) => {
		stored = profile;
	});
	const capture = vi.fn(async (_cwd: string, fallback: ModeModelProfile) => fallback);
	const restore = vi.fn(async () => {});
	const profileStore = { load, save } satisfies PlanModeProfileStore;
	return {
		dependencies: {
			profileStore,
			normalDefaultsStore: { capture, restore },
			waitForNativePersistence: async () => {},
		} satisfies PlanModeDependencies,
		load,
		save,
		capture,
		restore,
		getStored: () => stored,
	};
}

describe("simple plan review UI", () => {
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
		expect(harness.select).toHaveBeenCalledWith("A proposed plan is ready for review.", actionLabels);
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

	it("implements the current plan when selected", async () => {
		const plan = "# Implement Me";
		const harness = createHarness({ selection: "Implement current plan" });
		await initializeAndExtract(harness, plan);
		await harness.emit("agent_settled");

		expect(harness.sendUserMessage).toHaveBeenCalledWith(`Implement this proposed plan:\n\n${plan}`, undefined);
		expect(harness.setEditorText).not.toHaveBeenCalled();
	});

	it("starts a fresh implementation automatically when selected", async () => {
		const harness = createHarness({ selection: "Clear context and implement" });
		await initializeAndExtract(harness, "# Fresh Plan");
		await harness.emit("agent_settled");

		expect(harness.timeline).toContain("submit:/plan-implement-fresh");
		expect(harness.newSession).toHaveBeenCalledTimes(1);
		expect(harness.freshSendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Implement the plan in a fresh context"),
		);
		expect(harness.freshSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("# Fresh Plan"));
		expect(harness.setEditorText).not.toHaveBeenCalled();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("falls back to prefilling the command when automatic submission is unavailable", async () => {
		const harness = createHarness({
			selection: "Clear context and implement",
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
		expect(persistedStates.at(-1)).toMatchObject({ active: true, phase: "awaiting_review" });
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
				"Use /plan implement, /plan fresh, /plan revise, or /plan show.",
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
		expect(harness.setStatus).toHaveBeenLastCalledWith("plan", "📋 PLAN");

		await initializeAndExtract(harness, "# Status Bar Plan");
		await harness.emit("turn_end");
		expect(harness.setStatus).toHaveBeenLastCalledWith("plan", "📋 PLAN REVIEW");
		expect(harness.setStatus.mock.calls.flat().join(" ")).not.toContain("/");
	});
});

describe("Plan Mode tool policy integration", () => {
	it("uses the Bash policy only while Plan Mode is active", async () => {
		const active = createHarness();
		await active.emit("session_start", { type: "session_start", reason: "startup" });
		const [blocked] = await active.emit("tool_call", {
			type: "tool_call",
			toolName: "bash",
			input: { command: "rg foo; touch changed" },
		});
		expect(blocked).toEqual({
			block: true,
			reason: expect.stringContaining('Plan Mode blocked command 2: "touch"'),
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

describe("Plan Mode model and thinking profiles", () => {
	it("initializes the first profile from the current session", async () => {
		const stores = createProfileDependencies();
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);

		expect(stores.save).toHaveBeenCalledWith(profileFor(normalModel, "medium"));
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({
			active: true,
			normalProfile: profileFor(normalModel, "medium"),
		});
	});

	it("restores the saved Plan profile on entry and the conversation profile on exit", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);

		expect(harness.timeline).toEqual(expect.arrayContaining([
			"setModel:github-copilot/gpt-5.6-sol",
			"setThinking:high",
		]));
		expect(stores.restore).toHaveBeenCalledWith("/test/project", profileFor(normalModel, "medium"));
		expect(harness.notify).toHaveBeenLastCalledWith(
			"📋 Plan mode active: github-copilot/gpt-5.6-sol · high · 1,050,000 ctx. Normal on exit: anthropic/claude-sonnet-4.6 · medium · 1,000,000 ctx",
			"info",
		);

		await harness.commands.get("plan").handler("exit", harness.ctx);
		expect(harness.timeline.slice(-2)).toEqual([
			"setModel:anthropic/claude-sonnet-4.6",
			"setThinking:medium",
		]);
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({ active: false });
		expect(harness.appendedEntries.at(-1)?.data.normalProfile).toBeUndefined();
	});

	it("restores normal before sending an implementation prompt", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: {
				active: true,
				phase: "planning",
				setAt: 1,
				normalProfile: profileFor(normalModel, "medium"),
			},
		}];
		const harness = createHarness({
			branch, model: planModel, thinkingLevel: "high",
			selection: "Implement current plan",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await initializeAndExtract(harness, "# Restore Then Implement");
		await harness.emit("agent_settled");

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: normalModel.id }));
		expect(harness.timeline.indexOf("setThinking:medium")).toBeLessThan(
			harness.timeline.indexOf("sendUserMessage"),
		);
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Implement this proposed plan"),
			undefined,
		);
	});

	it("records model and thinking changes only while Plan Mode is active", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: {
				active: true,
				phase: "planning",
				setAt: 1,
				normalProfile: profileFor(normalModel, "medium"),
			},
		}];
		const harness = createHarness({
			branch, model: planModel, thinkingLevel: "high",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		stores.save.mockClear();

		harness.setCurrentModel(normalModel);
		await harness.emit("model_select", {
			type: "model_select", model: normalModel, previousModel: planModel, source: "cycle",
		});
		expect(stores.save).toHaveBeenLastCalledWith(profileFor(normalModel, "high"));

		harness.setCurrentThinkingLevel("xhigh");
		await harness.emit("thinking_level_select", {
			type: "thinking_level_select", level: "xhigh", previousLevel: "high",
		});
		expect(stores.save).toHaveBeenLastCalledWith(profileFor(normalModel, "xhigh"));
		expect(stores.restore).toHaveBeenCalled();

		await harness.commands.get("plan").handler("exit", harness.ctx);
		stores.save.mockClear();
		await harness.emit("model_select", {
			type: "model_select", model: planModel, previousModel: normalModel, source: "set",
		});
		expect(stores.save).not.toHaveBeenCalled();
	});

	it("does not let restored historical models redefine the global preference", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: { active: true, phase: "planning", setAt: 1, normalProfile: profileFor(normalModel, "medium") },
		}];
		const harness = createHarness({
			branch, model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("model_select", {
			type: "model_select", model: normalModel, previousModel: planModel, source: "restore",
		});
		expect(stores.save).not.toHaveBeenCalled();
		expect(stores.getStored()).toEqual(profileFor(planModel, "high"));
	});

	it("keeps Plan Mode active when normal restoration fails", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: { active: true, phase: "planning", setAt: 1, normalProfile: profileFor(normalModel, "medium") },
		}];
		const harness = createHarness({
			branch, model: planModel, thinkingLevel: "high", setModelResult: false,
			selection: "Implement current plan",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await initializeAndExtract(harness, "# Do Not Implement Yet");
		await harness.emit("agent_settled");

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("Could not exit Plan Mode"), "error");
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({ active: true });
	});

	it("reports unavailable and malformed profiles without entering", async () => {
		const missing = createProfileDependencies(profileFor(planModel, "high"));
		const missingHarness = createHarness({
			branch: [], model: normalModel, availableModels: [normalModel], dependencies: missing.dependencies,
		});
		await missingHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await missingHarness.commands.get("plan").handler("", missingHarness.ctx);
		expect(missingHarness.notify).toHaveBeenCalledWith(expect.stringContaining("is unavailable"), "error");

		const auth = createProfileDependencies(profileFor(planModel, "high"));
		const authHarness = createHarness({
			branch: [], model: normalModel, availableModels: [normalModel, planModel],
			setModelResult: false, dependencies: auth.dependencies,
		});
		await authHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await authHarness.commands.get("plan").handler("", authHarness.ctx);
		expect(authHarness.notify).toHaveBeenCalledWith(
			expect.stringContaining("No configured authentication"),
			"error",
		);

		const malformedHarness = createHarness({
			branch: [], model: normalModel, availableModels: [normalModel],
			dependencies: {
				...missing.dependencies,
				profileStore: {
					load: vi.fn(async () => { throw new Error("malformed profile"); }),
					save: vi.fn(),
				},
			},
		});
		await malformedHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await malformedHarness.commands.get("plan").handler("", malformedHarness.ctx);
		expect(malformedHarness.notify).toHaveBeenCalledWith(expect.stringContaining("malformed profile"), "error");
	});

	it("restores the normal profile through Shift+Tab and fresh implementation", async () => {
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: { active: true, phase: "planning", setAt: 1, normalProfile: profileFor(normalModel, "medium") },
		}];
		const shortcutStores = createProfileDependencies(profileFor(planModel, "high"));
		const shortcutHarness = createHarness({
			branch, model: planModel, thinkingLevel: "high",
			availableModels: [normalModel, planModel], dependencies: shortcutStores.dependencies,
		});
		await shortcutHarness.emit("session_start", { type: "session_start", reason: "reload" });
		await shortcutHarness.shortcuts.get("shift+tab").handler(shortcutHarness.ctx);
		expect(shortcutHarness.timeline.slice(-2)).toEqual([
			"setModel:anthropic/claude-sonnet-4.6",
			"setThinking:medium",
		]);

		const freshStores = createProfileDependencies(profileFor(planModel, "high"));
		const freshHarness = createHarness({
			branch, model: planModel, thinkingLevel: "high", selection: "Clear context and implement",
			availableModels: [normalModel, planModel], dependencies: freshStores.dependencies,
		});
		await initializeAndExtract(freshHarness, "# Fresh With Normal Model");
		await freshHarness.emit("agent_settled");
		expect(freshHarness.timeline.indexOf("setThinking:medium")).toBeLessThan(
			freshHarness.timeline.indexOf("newSession"),
		);
	});

	it("reports profile persistence failures and stays in normal mode", async () => {
		const stores = createProfileDependencies();
		stores.save.mockRejectedValueOnce(new Error("profile is read-only"));
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("profile is read-only"), "error");
		expect(harness.appendedEntries.some((entry) => entry.data.active)).toBe(false);
	});

	it("shows active and normal restoration profiles in /plan status", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);
		await harness.commands.get("plan").handler("status", harness.ctx);
		expect(harness.notify).toHaveBeenLastCalledWith(
			expect.stringContaining(
				"Plan: github-copilot/gpt-5.6-sol · high · 1,050,000 ctx. Normal on exit: anthropic/claude-sonnet-4.6 · medium · 1,000,000 ctx.",
			),
			"info",
		);
	});
});

describe("Plan Mode profile schema", () => {
	it("preserves normal defaults through Pi's native SettingsManager", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-normal-defaults-"));
		try {
			const settings = SettingsManager.create("/test/project", directory);
			settings.setDefaultModelAndProvider(planModel.provider, planModel.id);
			settings.setDefaultThinkingLevel("high");
			await settings.flush();

			const store = createNormalDefaultsStore(directory);
			expect(await store.capture("/test/project", profileFor(normalModel, "medium")))
				.toEqual({
					...profileFor(planModel, "high"),
					// Native settings have no context field; the active session fallback supplies it.
					contextWindow: normalModel.contextWindow,
				});
			await store.restore("/test/project", profileFor(normalModel, "medium"));

			const restored = SettingsManager.create("/test/project", directory).getGlobalSettings();
			expect(restored).toMatchObject({
				defaultProvider: normalModel.provider,
				defaultModel: normalModel.id,
				defaultThinkingLevel: "medium",
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("round-trips the versioned profile through one atomic target file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-plan-profile-"));
		const path = join(directory, "plan-mode-profile.json");
		try {
			const store = createPlanModeProfileStore(path);
			expect(await store.load()).toBeUndefined();
			await store.save(profileFor(planModel, "high"));
			expect(await store.load()).toEqual(profileFor(planModel, "high"));
			expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
				version: 2,
				profile: profileFor(planModel, "high"),
			});
			expect(readdirSync(directory)).toEqual(["plan-mode-profile.json"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("accepts current profiles and legacy v1 profiles without context", () => {
		expect(parsePlanModeProfileDocument({
			version: 2,
			profile: profileFor(planModel, "xhigh"),
		})).toEqual(profileFor(planModel, "xhigh"));
		expect(parsePlanModeProfileDocument({
			version: 1,
			profile: { provider: planModel.provider, modelId: planModel.id, thinkingLevel: "high" },
		})).toEqual({ provider: planModel.provider, modelId: planModel.id, thinkingLevel: "high" });
	});

	it("rejects malformed versions, thinking levels, and contexts", () => {
		expect(() => parsePlanModeProfileDocument({ version: 3, profile: profileFor(planModel, "high") }))
			.toThrow("unsupported version");
		expect(() => parsePlanModeProfileDocument({
			version: 2,
			profile: { ...profileFor(planModel, "high"), thinkingLevel: "turbo" },
		})).toThrow("thinkingLevel is not supported");
		expect(() => parsePlanModeProfileDocument({
			version: 2,
			profile: { ...profileFor(planModel, "high"), contextWindow: 0 },
		})).toThrow("contextWindow must be a positive integer");
	});
});
