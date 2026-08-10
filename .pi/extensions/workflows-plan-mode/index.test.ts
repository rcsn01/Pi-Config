import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import planModeExtension, { PLAN_REVIEW_ACTIONS } from "./index.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => unknown;

interface HarnessOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	branch?: any[];
	selection?: string;
	editorResult?: string;
	editorSubmitAvailable?: boolean;
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
	const renderers = new Map<string, any>();
	const timeline: string[] = [];
	const appendedEntries: Array<{ customType: string; data: any }> = [];

	const custom = vi.fn();
	const select = vi.fn(async () => {
		timeline.push("select");
		return options.selection;
	});
	const notify = vi.fn();
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
		setStatus: vi.fn(),
		setEditorText,
		getEditorComponent,
		setEditorComponent,
	} as any;
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui,
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
	const sendUserMessage = vi.fn();
	const appendEntry = vi.fn((customType: string, data: any) => {
		appendedEntries.push({ customType, data });
	});
	const pi = {
		on: (event: string, handler: EventHandler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerTool: vi.fn(),
		registerMessageRenderer: (customType: string, renderer: any) => renderers.set(customType, renderer),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerShortcut: vi.fn(),
		appendEntry,
		sendMessage,
		sendUserMessage,
	} as unknown as ExtensionAPI;

	planModeExtension(pi);

	async function emit(event: string, payload: any = { type: event }): Promise<any[]> {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	}

	return {
		ctx,
		emit,
		commands,
		renderers,
		timeline,
		appendedEntries,
		custom,
		select,
		notify,
		editor,
		setEditorText,
		getEditorComponent,
		setEditorComponent,
		newSession,
		freshSendUserMessage,
		sendMessage,
		sendUserMessage,
	};
}

async function initializeAndExtract(harness: ReturnType<typeof createHarness>, plan: string): Promise<void> {
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	await harness.emit("message_end", { type: "message_end", message: assistantWithPlan(plan) });
}

const actionLabels = PLAN_REVIEW_ACTIONS.map((action) => action.label);

describe("simple plan review UI", () => {
	it("renders the plan in chat before opening Pi's built-in selector", async () => {
		const plan = "# Exact Plan\n\n1. First\n2. Second";
		const harness = createHarness();
		await initializeAndExtract(harness, plan);
		await harness.emit("message_end", { type: "message_end", message: assistantWithPlan(plan) });

		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.select).not.toHaveBeenCalled();
		await harness.emit("agent_end", { type: "agent_end", messages: [] });
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.select).not.toHaveBeenCalled();

		await harness.emit("agent_settled");
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "proposed-plan", content: plan, display: true }),
			{ triggerTurn: false },
		);
		expect(harness.select).toHaveBeenCalledWith("A proposed plan is ready for review.", actionLabels);
		expect(harness.timeline.slice(-2)).toEqual(["message:proposed-plan", "select"]);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.renderers.has("proposed-plan")).toBe(true);
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
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.select).toHaveBeenCalledTimes(1);

		const revised = "# Plan Two\n\nMaterially revised version";
		await harness.emit("message_end", { type: "message_end", message: assistantWithPlan(revised) });
		await harness.emit("agent_settled");
		expect(harness.sendMessage).toHaveBeenCalledTimes(2);
		expect(harness.select).toHaveBeenCalledTimes(2);
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: revised }),
			{ triggerTurn: false },
		);
		expect(harness.custom).not.toHaveBeenCalled();
	});

	it("prints the current plan before re-prompting for ambiguous or repeated input", async () => {
		const plan = "# Current Plan\n\nKeep this exact proposal.";
		const harness = createHarness();
		await initializeAndExtract(harness, plan);
		await harness.emit("agent_settled");

		const ambiguous = await harness.emit("input", {
			type: "input",
			text: "continue",
			source: "interactive",
		});
		expect(harness.timeline.slice(-2)).toEqual(["message:proposed-plan", "select"]);

		const repeated = await harness.emit("input", {
			type: "input",
			text: plan,
			source: "interactive",
		});
		expect(harness.timeline.slice(-2)).toEqual(["message:proposed-plan", "select"]);

		expect(ambiguous).toEqual([{ action: "handled" }]);
		expect(repeated).toEqual([{ action: "handled" }]);
		expect(harness.sendMessage).toHaveBeenCalledTimes(3);
		expect(harness.select).toHaveBeenCalledTimes(3);
		expect(harness.custom).not.toHaveBeenCalled();
	});

	it("appends the plan but never opens approval UI outside TUI mode", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as any);
		try {
			const harness = createHarness({ mode: "print" });
			await initializeAndExtract(harness, "# Non-TUI Plan\n\nRun explicitly.");
			await harness.emit("agent_settled");
			await harness.emit("agent_settled");

			expect(harness.sendMessage).toHaveBeenCalledTimes(1);
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
				type: "custom_message",
				customType: "proposed-plan",
				content: plan,
				details: { signature: "durable-signature" },
			},
			{
				type: "custom",
				customType: "plan-mode-state",
				data: {
					active: true,
					phase: "awaiting_review",
					setAt: 1,
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
});
