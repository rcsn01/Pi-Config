import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubagentsExtension } from "./index.ts";
import { requireSubagentService } from "../_shared/subagent-service.ts";
import { createSubagentChildEventIngestion } from "./child-event-ingestion.ts";
import { agent, agentResult, deferred, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

// Exercise the actual host follow-up queue and idle continuation, not just sendMessage mocks.
describe("background subagents pinned-SDK host integration", () => {
	it.each(["rpc", "tui"] as const)("returns handles, queues a busy completion, and wakes an idle %s parent without network access", async (mode) => {
		const cwd = process.cwd();
		const faux = fauxProvider({ provider: "subagents-offline", models: [{ id: "parent", contextWindow: 100000, maxTokens: 4000 }] });
		const parentWorking = deferred(); const finishParent = deferred();
		const childGates = [deferred(), deferred()];
		const contexts: unknown[] = [];
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { tasks: [{ agent: "explorer", task: "first" }, { agent: "explorer", task: "second" }] }), { stopReason: "toolUse" }),
			async (context) => { contexts.push(context); parentWorking.resolve(); await finishParent.promise; return fauxAssistantMessage("I continued unrelated work."); },
			(context) => { contexts.push(context); return fauxAssistantMessage("Received first result."); },
			(context) => { contexts.push(context); return fauxAssistantMessage("Received idle result."); },
		]);
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
		let nextChild = 0;
		const extension = createSubagentsExtension({
			registry: memoryRegistry([agent({ name: "explorer" })]), config: memoryConfigStore({ maxConcurrency: 2 }),
			childExecution: {
				inspectTools: () => [],
				async execute(request) {
					const index = nextChild++;
					request.signal?.addEventListener("abort", () => childGates[index].resolve(), { once: true });
					const ingestion = createSubagentChildEventIngestion({ agentName: request.agent.name, task: request.task, model: request.launch.model, onProgress: request.onProgress, onUpdate: request.onUpdate });
					await childGates[index].promise;
					ingestion.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Child report ${index}` }] } }) + "\n");
					return ingestion.finish({ exitCode: 0, stderr: "" });
				},
			},
		});
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: faux.getModel("parent"), settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools: ["subagent", "subagent_status", "subagent_wait", "subagent_cancel"] });
		const events: any[] = []; const errors: unknown[] = []; const unsubscribe = session.subscribe((event) => events.push(event));
		try {
			await session.bindExtensions({ mode, onError: (error) => errors.push(error) });
			const prompt = session.prompt("Delegate and continue working.");
			await parentWorking.promise;
			expect(JSON.stringify(contexts[0])).toContain("Accepted background runs");
			expect(nextChild).toBe(2);
			childGates[0].resolve();
			await vi.waitFor(() => expect(session.agent.peekQueuedMessages()).toHaveLength(1));
			expect(faux.state.callCount).toBe(2);
			finishParent.resolve(); await prompt; await session.waitForIdle();
			expect(faux.state.callCount).toBe(3);
			expect(JSON.stringify(contexts[1])).toContain("Child report 0");
			childGates[1].resolve();
			await vi.waitFor(() => expect(faux.state.callCount).toBe(4)); await session.waitForIdle();
			expect(JSON.stringify(contexts[2])).toContain("Child report 1");
			expect(events.filter((e) => e.type === "message_end" && e.message?.customType === "subagent-completion")).toHaveLength(2);
		} finally {
			finishParent.resolve();
			try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
			finally { childGates.forEach((g) => g.resolve()); unsubscribe(); session.dispose(); }
		}
		expect(errors).toEqual([]);
	}, 10000);
});

let fixtureId = 0;
async function lifecycleHost(mode: "rpc" | "tui", before?: ExtensionFactory) {
	const cwd = process.cwd();
	const faux = fauxProvider({ provider: `subagents-lifecycle-${++fixtureId}`, models: [{ id: "parent", contextWindow: 100000, maxTokens: 4000 }] });
	faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Received child report.")));
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const sessionManager = SessionManager.inMemory(cwd);
	const base = sessionManager.appendCustomEntry("fixture", { name: "base" });
	const oldLeaf = sessionManager.appendCustomEntry("fixture", { name: "old" });
	sessionManager.branch(base);
	const destination = sessionManager.appendCustomEntry("fixture", { name: "destination" });
	sessionManager.branch(oldLeaf);
	const gates: ReturnType<typeof deferred<ReturnType<typeof agentResult>>>[] = [];
	const requests: any[] = [];
	const aborts: ReturnType<typeof deferred<void>>[] = [];
	const config = memoryConfigStore({ maxConcurrency: 1 });
	config.setSettingsPath(`/virtual/subagents-lifecycle-${fixtureId}/settings.json`);
	const extension = createSubagentsExtension({ registry: memoryRegistry([agent({ name: "explorer", tools: ["read"] })]), config,
		childExecution: {
			inspectTools: () => [],
			execute(request) {
				requests.push(request); const gate = deferred<ReturnType<typeof agentResult>>(); const aborted = deferred();
				gates.push(gate); aborts.push(aborted);
				request.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				return gate.promise;
			},
		},
	});
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [...(before ? [before] : []), extension] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: faux.getModel("parent"), settingsManager, resourceLoader, sessionManager, tools: ["subagent", "subagent_status"] });
	const errors: any[] = []; const completions: any[] = [];
	const unsubscribe = session.subscribe((event) => { if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "subagent-completion") completions.push(event.message); });
	await session.bindExtensions({ mode, onError: (error) => errors.push(error) });
	const tool = session.extensionRunner.getToolDefinition("subagent")!;
	const submit = (task = "inspect") => tool.execute("fixture", { tasks: [{ agent: "explorer", task }] }, undefined, undefined, session.extensionRunner.createContext());
	const status = (runId: string) => session.extensionRunner.getToolDefinition("subagent_status")!.execute("status", { runId }, undefined, undefined, session.extensionRunner.createContext());
	const close = async () => {
		const shutdown = session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		gates.forEach((gate, index) => {
			const signal = requests[index].signal as AbortSignal;
			if (signal.aborted) gate.resolve(agentResult());
			else signal.addEventListener("abort", () => gate.resolve(agentResult()), { once: true });
		});
		try { await shutdown; await session.waitForIdle(); } finally { unsubscribe(); session.dispose(); }
	};
	return { session, sessionManager, destination, oldLeaf: sessionManager.getLeafId()!, faux, gates, requests, aborts, errors, completions, submit, status, close };
}

describe("SDK lifecycle dispatch and navigation", () => {
	it.each(["rpc", "tui"] as const)("actual %s navigation drains pending work and allows fresh destination work", async (mode) => {
		const h = await lifecycleHost(mode);
		try {
			const result = await h.submit(); const oldId = (result.details as any).runs[0].runId;
			const navigation = h.session.navigateTree(h.destination, { summarize: false });
			await h.aborts[0].promise;
			await expect(h.submit("during retirement")).rejects.toThrow("admission is closed");
			h.gates[0].resolve(agentResult({ output: "old report" }));
			expect((await navigation).cancelled).toBe(false); expect(h.sessionManager.getLeafId()).toBe(h.destination);
			expect(h.completions).toEqual([]); await expect(h.status(oldId)).rejects.toThrow("unavailable");
			await h.submit("fresh work"); h.gates[1].resolve(agentResult({ output: "fresh report" }));
			await vi.waitFor(() => expect(h.completions).toHaveLength(1)); await h.session.waitForIdle();
			expect(h.completions[0].content).toContain("fresh report"); expect(h.errors).toEqual([]);
		} finally { await h.close(); }
	});
	it("same-leaf, missing-target and cancelled navigation do not retire the current owner", async () => {
		let cancel = false;
		const h = await lifecycleHost("rpc", (pi) => { pi.on("session_before_tree", () => cancel ? { cancel: true } : undefined); });
		try {
			await h.submit();
			expect((await h.session.navigateTree(h.oldLeaf, { summarize: false })).cancelled).toBe(false);
			await expect(h.session.navigateTree("missing", { summarize: false })).rejects.toThrow("not found");
			cancel = true; expect((await h.session.navigateTree(h.destination, { summarize: false })).cancelled).toBe(true);
			expect(h.requests[0].signal.aborted).toBe(false); expect(h.errors).toEqual([]);
		} finally { await h.close(); }
	});
	it("documents the actual destination-commit interval before an earlier tree handler releases Subagent dispatch", async () => {
		const entered = deferred(); const release = deferred();
		const h = await lifecycleHost("rpc", (pi) => { pi.on("session_tree", async () => { entered.resolve(); await release.promise; }); });
		try {
			await h.submit(); const navigation = h.session.navigateTree(h.destination, { summarize: false });
			await entered.promise; expect(h.sessionManager.getLeafId()).toBe(h.destination); expect(h.requests[0].signal.aborted).toBe(false);
			h.gates[0].resolve(agentResult({ output: "pre-callback report" }));
			await vi.waitFor(() => expect(h.completions).toHaveLength(1));
			expect(h.completions[0].content).toContain("pre-callback report");
			release.resolve(); expect((await navigation).cancelled).toBe(false);
			expect(h.errors).toEqual([]);
		} finally { release.resolve(); await h.close(); }
	});
	it.each(["rpc", "tui"] as const)("awaited %s shutdown cancels without a parent turn before context invalidation", async (mode) => {
		const h = await lifecycleHost(mode);
		try {
			vi.useFakeTimers();
			await h.submit(); const stale = h.session.extensionRunner.createContext();
			const shutdown = h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await h.aborts[0].promise;
			h.requests[0].onUpdate(agentResult().progress); h.gates[0].resolve(agentResult({ output: "partial shutdown report" }));
			await shutdown;
			expect(h.completions).toHaveLength(1); expect(h.completions[0].details.status).toBe("cancelled");
			expect(h.faux.state.callCount).toBe(0);
			h.session.dispose(); expect(() => stale.sessionManager.getSessionId()).toThrow(/stale/);
			await vi.advanceTimersByTimeAsync(150); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
			expect(h.errors).toEqual([]);
		} finally { vi.useRealTimers(); await h.close(); }
	});
	it("replaced facade suppresses an old pending refresh and late completion, including a stale getter", async () => {
		const old = await lifecycleHost("rpc"); let replacement: Awaited<ReturnType<typeof lifecycleHost>> | undefined;
		try {
			vi.useFakeTimers();
			await old.submit(); const oldFacade = requireSubagentService();
			old.session.dispose(); // Deliberately demonstrate suppression for a noncompliant embedder.
			replacement = await lifecycleHost("rpc"); const currentFacade = requireSubagentService(); expect(currentFacade).not.toBe(oldFacade);
			old.requests[0].onUpdate(agentResult().progress);
			old.gates[0].resolve(agentResult({ output: "late old report" }));
			await vi.advanceTimersByTimeAsync(150); vi.useRealTimers();
			expect(old.completions).toEqual([]); expect(old.errors).toEqual([]); expect(replacement.errors).toEqual([]);
			expect(requireSubagentService()).toBe(currentFacade);
		} finally { vi.useRealTimers(); await old.close(); if (replacement) await replacement.close(); }
	});
	it("an asynchronous send failure is reported by the runner while terminal retrieval remains intact", async () => {
		const h = await lifecycleHost("rpc"); const prompt = vi.spyOn(h.session.agent, "prompt").mockRejectedValue(new Error("async send failure"));
		try {
			const result = await h.submit(); const id = (result.details as any).runs[0].runId;
			h.gates[0].resolve(agentResult({ output: "retained report" }));
			await vi.waitFor(() => expect(h.errors).toContainEqual(expect.objectContaining({ event: "send_message", error: "async send failure" })));
			expect((await h.status(id)).content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("retained report") }));
		} finally { prompt.mockRestore(); await h.close(); }
	});
	it("runner reports a shutdown handler error and continues through Subagent cleanup", async () => {
		const h = await lifecycleHost("rpc", (pi: ExtensionAPI) => { pi.on("session_shutdown", () => { throw new Error("earlier handler failed"); }); });
		await h.close();
		expect(h.errors).toContainEqual(expect.objectContaining({ event: "session_shutdown", error: "earlier handler failed" }));
		expect(requireSubagentService).toThrow("unavailable");
	});
});
