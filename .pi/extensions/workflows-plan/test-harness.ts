import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { BashOperations, ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { ModelSelectionStore } from "../_shared/model-selection-store.ts";
import {
	createPlanModeExtension,
	type PlanModeDependencies,
	PLAN_REVIEW_ACTIONS,
	reviewActionLabels,
} from "./index.ts";
import type { ModeModelProfile } from "./model-profile.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => unknown;

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

export interface HarnessOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	branch?: any[];
	selection?: string;
	selectionPromise?: Promise<string | undefined>;
	editorResult?: string;
	editorPromise?: Promise<string | undefined>;
	editorSubmitAvailable?: boolean;
	newSessionCancelled?: boolean;
	newSessionError?: Error;
	freshSendUserMessageError?: Error;
	model?: any;
	thinkingLevel?: ModelThinkingLevel;
	availableModels?: any[];
	setModelResult?: boolean;
	activeTools?: string[];
	idle?: boolean;
	sandboxInitializeError?: Error;
	contextUsage?: ContextUsage;
	dependencies?: PlanModeDependencies;
}

export function activePlanningEntry(): any {
	return {
		type: "custom",
		customType: "plan-mode-state",
		data: {
			mode: "plan",
			revision: 1,
			changedAt: "2026-01-01T00:00:00.000Z",
			phase: "planning",
		},
	};
}

export function assistantWithPlan(plan: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text: `Before\n<proposed_plan>\n${plan}\n</proposed_plan>\nAfter` }],
	};
}

export const DEFAULT_CONTEXT_USAGE: ContextUsage = {
	tokens: 500_000,
	contextWindow: 1_000_000,
	percent: 50,
};

export function createHarness(options: HarnessOptions = {}) {
	const mode = options.mode ?? "tui";
	let branch = options.branch ?? [activePlanningEntry()];
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const renderers = new Map<string, any>();
	const entryRenderers = new Map<string, any>();
	const tools = new Map<string, any>();
	const timeline: string[] = [];
	let activeTools = [...(options.activeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"] )];
	let currentModel = options.model;
	let thinkingLevel = options.thinkingLevel ?? "medium";
	let idle = options.idle ?? true;
	const appendedEntries: Array<{ customType: string; data: any }> = [];
	const registrations: string[] = [];
	const abort = vi.fn();

	const custom = vi.fn();
	const select = vi.fn(async () => {
		timeline.push("select");
		return options.selectionPromise ? await options.selectionPromise : options.selection;
	});
	const notify = vi.fn();
	const setStatus = vi.fn();
	const editor = vi.fn(async () => options.editorPromise ? await options.editorPromise : options.editorResult);
	const setEditorText = vi.fn();
	const freshSendUserMessage = vi.fn(async () => {
		if (options.freshSendUserMessageError) throw options.freshSendUserMessageError;
	});
	const freshAppendCustomEntry = vi.fn();
	const newSession = vi.fn(async (sessionOptions?: any) => {
		timeline.push("newSession");
		if (options.newSessionError) throw options.newSessionError;
		if (options.newSessionCancelled) return { cancelled: true };
		await sessionOptions?.setup?.({ appendCustomEntry: freshAppendCustomEntry });
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
	const contextUsage = options.contextUsage ?? DEFAULT_CONTEXT_USAGE;
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: "/test/project",
		ui,
		getContextUsage: vi.fn(() => contextUsage),
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
			getSessionId: () => "test-session",
		},
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort,
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
	const sandboxExec = vi.fn(async (..._args: Parameters<BashOperations["exec"]>): Promise<{ exitCode: number | null }> => ({ exitCode: 0 }));
	const sandboxDispose = vi.fn(async () => {});
	const workspaceDispose = vi.fn(async () => {});
	const defaultCreateWorkspace = vi.fn(async (hostRoot: string) => ({
		root: "/tmp/plan",
		hostRoot,
		sandboxRoot: "/tmp/plan/project",
		tempRoot: "/tmp/plan/tmp",
		dispose: workspaceDispose,
	}));
	const defaultCreateSandbox = vi.fn(() => ({
		operations: { exec: sandboxExec },
		initialize: vi.fn(async () => {
			if (options.sandboxInitializeError) throw options.sandboxInitializeError;
		}),
		dispose: sandboxDispose,
	}));
	const runtimeDependencies: PlanModeDependencies = {
		...options.dependencies,
		createWorkspace: options.dependencies?.createWorkspace ?? defaultCreateWorkspace,
		createSandbox: options.dependencies?.createSandbox ?? defaultCreateSandbox,
	};
	const pi = {
		on: (event: string, handler: EventHandler) => {
			registrations.push(`event:${event}`);
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerTool: vi.fn((definition: any) => {
			registrations.push(`tool:${definition.name}`);
			tools.set(definition.name, definition);
		}),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			activeTools = [...names];
			timeline.push(`setActiveTools:${names.join(",")}`);
		}),
		registerMessageRenderer: (customType: string, renderer: any) => {
			registrations.push(`message-renderer:${customType}`);
			renderers.set(customType, renderer);
		},
		registerEntryRenderer: (customType: string, renderer: any) => {
			registrations.push(`entry-renderer:${customType}`);
			entryRenderers.set(customType, renderer);
		},
		registerCommand: (name: string, definition: any) => {
			registrations.push(`command:${name}`);
			commands.set(name, definition);
		},
		registerShortcut: (shortcut: string, definition: any) => {
			registrations.push(`shortcut:${shortcut}`);
			shortcuts.set(shortcut, definition);
		},
		appendEntry,
		sendMessage,
		sendUserMessage,
		setModel,
		getThinkingLevel: vi.fn(() => thinkingLevel),
		setThinkingLevel,
	} as unknown as ExtensionAPI;

	createPlanModeExtension(runtimeDependencies)(pi);

	async function emit(
		event: string,
		payload: any = { type: event },
		eventContext: ExtensionContext = ctx,
	): Promise<any[]> {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, eventContext));
		return results;
	}

	return {
		ctx,
		emit,
		commands,
		shortcuts,
		tools,
		getActiveToolNames: () => [...activeTools],
		setBranch: (nextBranch: any[]) => {
			branch = nextBranch;
		},
		sandboxExec,
		sandboxDispose,
		workspaceDispose,
		renderers,
		entryRenderers,
		registrations,
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
		freshAppendCustomEntry,
		sendMessage,
		sendUserMessage,
		setModel,
		setThinkingLevel,
		abort,
		setIdle: (nextIdle: boolean) => {
			idle = nextIdle;
		},
		setCurrentModel: (model: any) => {
			currentModel = model;
		},
		setCurrentThinkingLevel: (level: ModelThinkingLevel) => {
			thinkingLevel = level;
		},
	};
}

export async function initializeAndExtract(harness: ReturnType<typeof createHarness>, plan: string): Promise<any[]> {
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	return harness.emit("message_end", { type: "message_end", message: assistantWithPlan(plan) });
}

export const actionLabels = reviewActionLabels(DEFAULT_CONTEXT_USAGE.percent);

export const normalModel = {
	provider: "anthropic",
	id: "claude-sonnet-4.6",
	name: "Claude Sonnet 4.6",
	contextWindow: 1_000_000,
	reasoning: true,
};
export const planModel = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	contextWindow: 1_050_000,
	reasoning: true,
};

export function profileFor(model: typeof normalModel, thinkingLevel: ModelThinkingLevel): ModeModelProfile {
	return { provider: model.provider, modelId: model.id, thinkingLevel, contextWindow: model.contextWindow };
}

export function createProfileDependencies(initial?: ModeModelProfile) {
	let stored = initial;
	const load = vi.fn(async (mode: "normal" | "plan") => {
		if (mode !== "plan") throw new Error(`Unexpected model-selection mode: ${mode}`);
		return stored;
	});
	const save = vi.fn(async (mode: "normal" | "plan", profile: ModeModelProfile) => {
		if (mode !== "plan") throw new Error(`Unexpected model-selection mode: ${mode}`);
		stored = profile;
	});
	const capture = vi.fn(async (_cwd: string, fallback: ModeModelProfile) => fallback);
	const restore = vi.fn(async () => {});
	const setPath = vi.fn();
	const profileStore = { load, save, setPath } satisfies ModelSelectionStore;
	return {
		dependencies: {
			profileStore,
			normalDefaultsStore: { capture, restore },
			waitForNativePersistence: async () => {},
		} satisfies PlanModeDependencies,
		load,
		save,
		setPath,
		capture,
		restore,
		getStored: () => stored,
	};
}

