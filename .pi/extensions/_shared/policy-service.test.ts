import { describe, expect, it } from "vitest";
import {
	createPolicyService,
	parseChildPolicySnapshot,
	type PolicyAction,
} from "./policy-service.ts";

const writeAction: PolicyAction<"workspace-write"> = {
	effect: "workspace-write",
	description: "Update a source file",
	details: { path: "src/index.ts" },
};

describe("policy service", () => {
	it("reports unmanaged without a provider", async () => {
		const service = createPolicyService();
		await expect(service.evaluate(writeAction)).resolves.toEqual({
			outcome: "unmanaged",
			reason: "No policy provider is registered.",
		});
		expect(service.createChildSnapshot()).toBeUndefined();
	});

	it("allows one provider and applies scoped overrides only to narrow decisions", async () => {
		const service = createPolicyService();
		const unregister = service.registerProvider({
			id: "safety-permissions",
			evaluate: () => ({ outcome: "allow", reason: "Base mode allows this action." }),
			snapshot: () => ({ mode: "default" }),
		});
		const popPrompt = service.pushOverride({
			id: "review-writes",
			reason: "Writes require review in this scope.",
			effects: { "workspace-write": "prompt" },
		});
		const popReadOnly = service.pushOverride({
			id: "plan-mode",
			reason: "Plan mode is read-only.",
			effects: { "workspace-write": "deny" },
		});

		await expect(service.evaluate(writeAction)).resolves.toMatchObject({
			outcome: "deny",
			overrideId: "plan-mode",
		});
		popReadOnly();
		await expect(service.evaluate(writeAction)).resolves.toMatchObject({
			outcome: "prompt",
			overrideId: "review-writes",
		});
		popPrompt();
		await expect(service.evaluate(writeAction)).resolves.toMatchObject({ outcome: "allow" });
		unregister();
		await expect(service.evaluate(writeAction)).resolves.toMatchObject({ outcome: "unmanaged" });
	});

	it("round-trips detached child snapshots and rejects non-JSON provider state", () => {
		const service = createPolicyService();
		service.registerProvider({
			id: "safety-permissions",
			evaluate: () => ({ outcome: "allow", reason: "Allowed." }),
			snapshot: () => ({ mode: "default" }),
		});
		service.pushOverride({
			id: "workflow-read-only",
			reason: "Workflow declared read-only capabilities.",
			effects: { "workspace-write": "deny", "external-write": "deny" },
		});

		const snapshot = service.createChildSnapshot();
		expect(parseChildPolicySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);

		const invalid = createPolicyService();
		invalid.registerProvider({
			id: "invalid-provider",
			evaluate: () => ({ outcome: "allow", reason: "Allowed." }),
			snapshot: () => ({ value: undefined }) as never,
		});
		expect(() => invalid.createChildSnapshot()).toThrow(/JSON-serializable/);
	});
});