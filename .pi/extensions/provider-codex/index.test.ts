import { describe, expect, it, vi } from "vitest";
import type {
	CodexCredentialSlotInspection,
	CodexCredentialSlotMutation,
	CodexCredentialSlotStore,
} from "./credential-slots.ts";
import { createCodexExtension, formatSlotList, runCodexCommand, type CodexCredentialSlotStoreLike } from "./index.ts";

const inspection: CodexCredentialSlotInspection = {
	revision: "revision-1",
	activeSlotId: "default",
	activeSlotName: "default",
	slots: [
		{ id: "default", name: "default", active: true, hasCredential: true, status: "active" },
		{ id: "work-id", name: "work", active: false, hasCredential: true, status: "saved" },
		{ id: "empty-id", name: "empty", active: false, hasCredential: false, status: "empty" },
	],
};

function mutation(overrides: Partial<CodexCredentialSlotMutation> = {}): CodexCredentialSlotMutation {
	return { ...inspection, changed: true, ...overrides };
}

function storeHarness(overrides: Partial<Record<keyof CodexCredentialSlotStoreLike, unknown>> = {}) {
	const store = {
		inspect: vi.fn(() => inspection),
		createAndSwitch: vi.fn(async (name: string) => mutation({ activeSlotName: name, created: name })),
		switchTo: vi.fn(async (name: string) => mutation({ activeSlotName: name })),
		remove: vi.fn(async (name: string, _revision: string) => mutation({ removed: name })),
		...overrides,
	} as unknown as CodexCredentialSlotStoreLike;
	return store;
}

function context(overrides: Record<string, unknown> = {}) {
	const notify = vi.fn();
	const select = vi.fn();
	const input = vi.fn();
	const confirm = vi.fn();
	const waitForIdle = vi.fn(async () => {});
	const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
	return {
		ctx: {
			mode: "tui",
			hasUI: true,
			ui: { notify, select, input, confirm },
			waitForIdle,
			modelRegistry: { refresh },
			...overrides,
		},
		notify,
		select,
		input,
		confirm,
		waitForIdle,
		refresh,
	};
}

function commandFor(store: CodexCredentialSlotStoreLike) {
	const commands = new Map<string, any>();
	createCodexExtension({ store })({
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
	} as any);
	return commands.get("codex");
}

describe("provider-codex command", () => {
	it("formats statuses without account IDs or credential data", () => {
		const text = formatSlotList(inspection);
		expect(text).toContain("* default (active)");
		expect(text).toContain("work (saved)");
		expect(text).toContain("empty (empty)");
		expect(text).not.toContain("work-id");
		expect(text).not.toContain("revision-1");
	});

	it("lists slots directly and gives textual status in non-TUI mode", async () => {
		const store = storeHarness();
		const command = commandFor(store);
		const h = context({ mode: "print", hasUI: false });

		await command.handler("list", h.ctx);
		await command.handler("", h.ctx);

		expect(h.notify).toHaveBeenNthCalledWith(1, expect.stringContaining("Codex credential slots:"), "info");
		expect(h.notify).toHaveBeenNthCalledWith(2, expect.stringContaining("Usage: /codex"), "info");
		expect(h.select).not.toHaveBeenCalled();
	});

	it("cancels the interactive picker without changing credentials", async () => {
		const store = storeHarness();
		const h = context();
		h.select.mockResolvedValue(undefined);

		await runCodexCommand("", h.ctx as any, store);

		expect(h.select).toHaveBeenCalled();
		expect(store.switchTo).not.toHaveBeenCalled();
		expect(store.createAndSwitch).not.toHaveBeenCalled();
		expect(h.waitForIdle).not.toHaveBeenCalled();
	});

	it("offers a new empty slot, waits for idle, refreshes Pi, and explains login", async () => {
		const store = storeHarness({
			createAndSwitch: vi.fn(async () => mutation({
				activeSlotName: "personal",
				activeSlotId: "personal-id",
				created: "personal",
				slots: [
					{ id: "default", name: "default", active: false, hasCredential: true, status: "saved" },
					{ id: "personal-id", name: "personal", active: true, hasCredential: false, status: "active" },
				],
			})),
		});
		const h = context();
		h.select.mockResolvedValue("  New empty slot");
		h.input.mockResolvedValue(" personal ");

		await runCodexCommand("", h.ctx as any, store);

		expect(h.input).toHaveBeenCalledWith("New Codex credential slot name", "slot-name");
		expect(h.waitForIdle).toHaveBeenCalledOnce();
		expect(store.createAndSwitch).toHaveBeenCalledWith("personal");
		expect(h.refresh).toHaveBeenCalledWith({ allowNetwork: false, providers: ["openai-codex"] });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("/login openai-codex"), "info");
	});

	it("uses an existing slot by name and does not wait when it is already active", async () => {
		const store = storeHarness();
		const h = context();

		await runCodexCommand("use default", h.ctx as any, store);
		expect(h.notify).toHaveBeenCalledWith('Codex slot "default" is already active.', "info");
		expect(store.switchTo).not.toHaveBeenCalled();
		expect(h.waitForIdle).not.toHaveBeenCalled();

		(store.switchTo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mutation({
			activeSlotId: "work-id",
			activeSlotName: "work",
			slots: [
				{ id: "default", name: "default", active: false, hasCredential: true, status: "saved" },
				{ id: "work-id", name: "work", active: true, hasCredential: true, status: "active" },
			],
		}));
		await runCodexCommand("use work", h.ctx as any, store);
		expect(h.waitForIdle).toHaveBeenCalledOnce();
		expect(store.switchTo).toHaveBeenCalledWith("work");
		expect(h.notify).toHaveBeenCalledWith('Switched to Codex slot "work".', "info");
	});

	it("confirms removal of a saved credential and passes the listed revision", async () => {
		const store = storeHarness();
		const h = context();
		h.confirm.mockResolvedValue(true);

		await runCodexCommand("remove work", h.ctx as any, store);

		expect(h.confirm).toHaveBeenCalledWith(
			'Remove Codex slot "work"?',
			"This permanently removes the credential saved in that inactive slot.",
		);
		expect(h.waitForIdle).toHaveBeenCalledOnce();
		expect(store.remove).toHaveBeenCalledWith("work", "revision-1");
		expect(h.notify).toHaveBeenCalledWith('Removed Codex slot "work".', "info");
	});

	it("does not remove a saved credential after confirmation is cancelled", async () => {
		const store = storeHarness();
		const h = context();
		h.confirm.mockResolvedValue(false);

		await runCodexCommand("remove work", h.ctx as any, store);

		expect(store.remove).not.toHaveBeenCalled();
		expect(h.waitForIdle).not.toHaveBeenCalled();
	});

	it("removes an empty slot without opening a confirmation dialog", async () => {
		const store = storeHarness();
		const h = context();

		await runCodexCommand("remove empty", h.ctx as any, store);

		expect(h.confirm).not.toHaveBeenCalled();
		expect(store.remove).toHaveBeenCalledWith("empty", "revision-1");
	});

	it("does not expose unknown errors and rejects malformed command arguments", async () => {
		const secret = "refresh-token-value";
		const store = storeHarness({
			switchTo: vi.fn(async () => { throw new Error(secret); }),
		});
		const h = context();

		await runCodexCommand("use work", h.ctx as any, store);
		await runCodexCommand("use work extra", h.ctx as any, store);

		expect(h.notify).toHaveBeenCalledWith("Could not read or update Codex credential slots.", "error");
		expect(h.notify.mock.calls.flat().join(" ")).not.toContain(secret);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /codex"), "warning");
	});

	it("requires the TUI before deleting a saved credential in print mode", async () => {
		const store = storeHarness();
		const h = context({ mode: "print", hasUI: false });

		await runCodexCommand("remove work", h.ctx as any, store);

		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("interactive TUI confirmation"), "warning");
		expect(store.remove).not.toHaveBeenCalled();
	});

	it("registers one command with safe slot completions", () => {
		const command = commandFor(storeHarness());
		expect(command.description).toContain("Codex");
		expect(command.getArgumentCompletions("u")).toEqual([{ value: "use", label: "use" }]);
	});
});
