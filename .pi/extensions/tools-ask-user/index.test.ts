import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import askUserExtension, {
	AskUserComponent,
	AskUserParams,
	createAskUserTool,
	NONE_OF_THE_ABOVE,
} from "./index.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as any;
}

const defaultKeys: Record<string, string> = {
	up: "tui.select.up",
	down: "tui.select.down",
	enter: "tui.select.confirm",
	escape: "tui.select.cancel",
	tab: "tui.input.tab",
	submit: "tui.input.submit",
};

function keybindings(keys = defaultKeys) {
	return {
		matches: (data: string, action: string) => keys[data] === action,
	} as any;
}

type Script = (component: AskUserComponent) => void;

function context(options: {
	mode?: "tui" | "rpc" | "print" | "json";
	hasUI?: boolean;
	scripts?: Script[];
	keys?: Record<string, string>;
} = {}) {
	const scripts = [...(options.scripts ?? [])];
	const ui = {
		select: vi.fn(),
		input: vi.fn(),
		custom: vi.fn((builder: any) => new Promise((resolve) => {
			const component = builder(
				{ requestRender: vi.fn() },
				theme(),
				keybindings(options.keys),
				resolve,
			);
			component.focused = true;
			const script = scripts.shift();
			if (!script) throw new Error("Missing custom UI script");
			script(component);
		})),
	};
	return {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui,
	} as any;
}

const question = {
	id: "scope",
	question: "Which scope?",
	options: [
		{ label: "Small", description: "Change one module" },
		{ label: "Medium", description: "Change a few modules" },
		{ label: "Large", description: "Change all modules" },
	],
	recommended: "Small",
};

function press(...keys: string[]): Script {
	return (component) => keys.forEach((key) => component.handleInput(key));
}

function makeComponent(done = vi.fn(), keys = defaultKeys) {
	const component = new AskUserComponent(
		question.question,
		[...question.options, NONE_OF_THE_ABOVE],
		question.recommended,
		{ requestRender: vi.fn() },
		theme(),
		keybindings(keys),
		done,
	);
	component.focused = true;
	return component;
}

describe("ask_user", () => {
	it("registers a sequential tool whose schema requires exactly three generated choices", () => {
		const registerTool = vi.fn();
		askUserExtension({ registerTool } as any);
		expect(registerTool).toHaveBeenCalledOnce();

		const tool = registerTool.mock.calls[0][0];
		expect(tool).toMatchObject({
			name: "ask_user",
			label: "Ask User",
			executionMode: "sequential",
			description: expect.stringContaining("exactly three options"),
			promptSnippet: "Ask concise multiple-choice clarification questions",
			promptGuidelines: expect.arrayContaining([expect.stringContaining("never generate")]),
		});
		const optionsSchema = (tool.parameters as any).properties.questions.items.properties.options;
		expect(optionsSchema).toMatchObject({ minItems: 3, maxItems: 3 });
		expect(optionsSchema.description).toContain("do not include");
		expect(Value.Check(AskUserParams, { questions: [question] })).toBe(true);
		expect(Value.Check(AskUserParams, {
			questions: [{ ...question, options: question.options.slice(0, 2) }],
		})).toBe(false);
	});

	it("enforces exactly three options at runtime and rejects a generated None of the above", async () => {
		const tool = createAskUserTool();
		const ctx = context();
		const short = await tool.execute("call", {
			questions: [{ ...question, options: question.options.slice(0, 2) }],
		} as any, undefined, undefined, ctx);
		expect(short).toMatchObject({ isError: true });
		expect(short.content[0]).toMatchObject({ text: expect.stringContaining("exactly 3") });

		const duplicate = await tool.execute("call", {
			questions: [{
				...question,
				options: [...question.options.slice(0, 2), { label: " none OF THE above " }],
			}],
		}, undefined, undefined, ctx);
		expect(duplicate).toMatchObject({ isError: true });
		expect(duplicate.content[0]).toMatchObject({ text: expect.stringContaining("added automatically") });
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("automatically renders option 4 and shows note guidance once at the bottom", () => {
		const component = makeComponent();
		const renderedLines = component.render(100);
		const text = renderedLines.join("\n");
		expect(renderedLines).toContain("> 1. Small (recommended) — Change one module");
		expect(text).toContain("4. None of the above — Optionally, add details in notes (tab)");
		expect(text).toContain("Optionally, add details in notes (tab)");
		expect(text.match(/Optional notes \(Tab\)/g)).toHaveLength(1);
	});

	it("opens notes with Tab and submits notes immediately with Enter for each option", () => {
		for (let optionIndex = 0; optionIndex < 4; optionIndex++) {
			const done = vi.fn();
			const component = makeComponent(done);
			for (let index = 0; index < optionIndex; index++) component.handleInput("down");
			component.handleInput("tab");
			for (const character of `note-${optionIndex + 1}`) component.handleInput(character);
			component.handleInput("submit");
			expect(done).toHaveBeenCalledWith({ index: optionIndex, notes: `note-${optionIndex + 1}` });
		}
	});

	it("distinguishes Escape from note editing from Escape in the selector", () => {
		const done = vi.fn();
		const component = makeComponent(done);
		component.handleInput("tab");
		component.handleInput("draft");
		component.handleInput("escape");
		expect(done).not.toHaveBeenCalled();
		component.handleInput("enter");
		expect(done).toHaveBeenCalledWith({ index: 0 });

		const cancel = vi.fn();
		makeComponent(cancel).handleInput("escape");
		expect(cancel).toHaveBeenCalledWith(undefined);
	});

	it("uses configured navigation, note, confirmation, and cancellation keybindings", () => {
		const keys = {
			k: "tui.select.up",
			j: "tui.select.down",
			y: "tui.select.confirm",
			x: "tui.select.cancel",
			n: "tui.input.tab",
			s: "tui.input.submit",
		};
		const done = vi.fn();
		const component = makeComponent(done, keys);
		component.handleInput("j");
		component.handleInput("n");
		component.handleInput("detail");
		component.handleInput("s");
		expect(done).toHaveBeenCalledWith({ index: 1, notes: "detail" });

		const selected = vi.fn();
		const selector = makeComponent(selected, keys);
		selector.handleInput("j");
		selector.handleInput("j");
		selector.handleInput("k");
		selector.handleInput("y");
		expect(selected).toHaveBeenCalledWith({ index: 1 });
	});

	it("collects ordered, 1-based answers and notes across sequential questions", async () => {
		const tool = createAskUserTool();
		const ctx = context({ scripts: [
			press("tab", "scope note", "submit"),
			press("down", "down", "enter"),
		] });
		const result = await tool.execute("call", {
			questions: [question, {
				id: "color",
				question: "Which color?",
				options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
			}],
		}, undefined, undefined, ctx);

		expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
		expect(result.details).toEqual({
			answers: [
				{ id: "scope", question: "Which scope?", answer: "Small", index: 1, notes: "scope note" },
				{ id: "color", question: "Which color?", answer: "Green", index: 3 },
			],
			cancelled: false,
		});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Notes: scope note") });
	});

	it("supports details for None of the above", async () => {
		const tool = createAskUserTool();
		const ctx = context({ scripts: [press("down", "down", "down", "tab", "Use a plugin", "submit")] });
		const result = await tool.execute("call", { questions: [question] }, undefined, undefined, ctx);
		expect(result.details.answers[0]).toEqual({
			id: "scope",
			question: "Which scope?",
			answer: "None of the above",
			index: 4,
			notes: "Use a plugin",
		});
	});

	it("returns ordered partial results when a later question is cancelled", async () => {
		const tool = createAskUserTool();
		const ctx = context({ scripts: [press("down", "enter"), press("escape")] });
		const result = await tool.execute("call", {
			questions: [question, { ...question, id: "later", question: "Continue?" }],
		}, undefined, undefined, ctx);
		expect(result.details).toEqual({
			answers: [
				{ id: "scope", question: "Which scope?", answer: "Medium", index: 2 },
				{ id: "later", question: "Continue?", answer: null, cancelled: true },
			],
			cancelled: true,
		});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("scope: 2. Medium") });
	});

	it("uses RPC selection followed by optional notes", async () => {
		const tool = createAskUserTool();
		const ctx = context({ mode: "rpc" });
		ctx.ui.select.mockResolvedValue("4. None of the above — Optionally, add details in notes (tab)");
		ctx.ui.input.mockResolvedValue("A custom direction");
		const result = await tool.execute("call", { questions: [question] }, undefined, undefined, ctx);
		expect(ctx.ui.select).toHaveBeenCalledWith("Which scope?", [
			"1. Small (recommended) — Change one module",
			"2. Medium — Change a few modules",
			"3. Large — Change all modules",
			"4. None of the above — Optionally, add details in notes (tab)",
		]);
		expect(ctx.ui.input).toHaveBeenCalledWith("Optional notes for None of the above", "Leave blank for no notes");
		expect(result.details.answers[0]).toMatchObject({ answer: "None of the above", index: 4, notes: "A custom direction" });
	});

	it("returns errors in print, JSON, and UI-less modes", async () => {
		const tool = createAskUserTool();
		for (const ctx of [context({ mode: "print" }), context({ mode: "json" }), context({ hasUI: false })]) {
			const result = await tool.execute("call", { questions: [question] }, undefined, undefined, ctx);
			expect(result).toMatchObject({ isError: true, details: { answers: [], cancelled: true } });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("interactive UI") });
		}
	});

	it("renders width-safe UI lines and notes in tool results", () => {
		const component = new AskUserComponent(
			"A very long question that must wrap safely?",
			[
				{ label: "A very long first option", description: "A description that also wraps" },
				...question.options.slice(1),
				NONE_OF_THE_ABOVE,
			],
			undefined,
			{ requestRender: vi.fn() },
			theme(),
			keybindings(),
			vi.fn(),
		);
		for (const width of [1, 8, 20]) {
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		component.handleInput("tab");
		component.handleInput("long note text");
		for (const width of [1, 8, 20]) {
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}

		const tool = createAskUserTool();
		const rendered = tool.renderResult?.({
			content: [{ type: "text", text: "done" }],
			details: {
				answers: [{ id: "scope", question: "Which?", answer: "Small", index: 1, notes: "Only core" }],
				cancelled: false,
			},
		}, {} as any, theme(), {} as any).render(80).join("\n");
		expect(rendered).toContain("✓ scope: 1. Small");
		expect(rendered).toContain("Notes: Only core");
	});
});
