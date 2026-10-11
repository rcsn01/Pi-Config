import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubagentsExtension } from "./index.ts";
import { createSubagentChildEventIngestion } from "./child-event-ingestion.ts";
import { agent, deferred, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

// Exercise the actual host follow-up queue and idle continuation, not just sendMessage mocks.
describe("background subagents installed-host integration", () => {
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
		const events: any[] = []; const unsubscribe = session.subscribe((event) => events.push(event));
		try {
			await session.bindExtensions({ mode });
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
		} finally { childGates.forEach((g) => g.resolve()); finishParent.resolve(); unsubscribe(); session.dispose(); }
	}, 10000);
});
