import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import goalExtension from "./index.ts";

describe("workflows-goal installed-host integration", () => {
	it("starts one hidden continuation run after an ordinary run settles", async () => {
		const cwd = process.cwd();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendCustomEntry("goal-state", {
			action: "set",
			state: {
				goalId: "host-goal",
				objective: "Exercise automatic continuation",
				status: "active",
				createdAt: 1,
				updatedAt: 1,
			},
		});
		sessionManager.appendCustomEntry("goal-runtime", {
			goalId: "host-goal",
			continuationRuns: 29,
			consecutiveNoProgressRuns: 0,
			consecutiveFailureRuns: 0,
			updatedAt: 1,
		});

		const faux = fauxProvider({
			provider: "goal-test",
			models: [{ id: "goal-test-model", contextWindow: 100_000, maxTokens: 4_000 }],
		});
		const modelContexts: unknown[] = [];
		faux.setResponses([
			(context) => {
				modelContexts.push(context);
				return fauxAssistantMessage("Initial run finished.");
			},
			(context) => {
				modelContexts.push(context);
				return fauxAssistantMessage("Continuation run finished.");
			},
		]);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
		let beforeAgentStartCalls = 0;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => { pi.on("before_agent_start", () => { beforeAgentStartCalls += 1; }); },
				goalExtension,
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime,
			model: faux.getModel("goal-test-model"),
			resourceLoader,
			sessionManager,
			settingsManager,
			tools: ["goal"],
		});
		const events: any[] = [];
		const unsubscribe = session.subscribe((event) => events.push(event));
		try {
			await session.bindExtensions({});
			await session.prompt("Begin the goal.");
			await session.waitForIdle();

			expect(faux.state.callCount).toBe(2);
			expect(events.filter((event) => event.type === "agent_start")).toHaveLength(2);
			expect(beforeAgentStartCalls).toBe(1);
			expect(JSON.stringify(modelContexts[1])).toContain("The persistent goal is still active");
			expect(events).toContainEqual(expect.objectContaining({
				type: "message_start",
				message: expect.objectContaining({
					role: "custom",
					customType: "goal-continuation",
					display: false,
				}),
			}));
			expect(sessionManager.getBranch()).toContainEqual(expect.objectContaining({
				type: "custom",
				customType: "goal-state",
				data: expect.objectContaining({
					action: "limit",
					state: expect.objectContaining({ status: "budget_limited" }),
				}),
			}));
			const runtimeEntries = sessionManager.getBranch().filter(
				(entry: any) => entry.type === "custom" && entry.customType === "goal-runtime",
			) as Array<{ data: { goalId: string; continuationRuns: number } }>;
			expect(runtimeEntries.length).toBeGreaterThanOrEqual(3);
			for (const entry of runtimeEntries) {
				expect(entry.data).toMatchObject({ goalId: "host-goal" });
				expect(entry.data.continuationRuns).toBeLessThanOrEqual(30);
			}
			expect(runtimeEntries.at(-1)).toMatchObject({
				data: { goalId: "host-goal", continuationRuns: 30 },
			});
		} finally {
			unsubscribe();
			session.dispose();
		}
	});
});
