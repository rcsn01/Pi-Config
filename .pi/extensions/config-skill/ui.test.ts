import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { SkillMenuView, SkillUpdateNotice } from "./skill-update-lifecycle.ts";
import { createPiSkillUpdateInteraction } from "./ui.ts";

function rpcContext(selections: (string | undefined)[] = []) {
	const ui = {
		select: vi.fn(async () => selections.shift()),
		confirm: vi.fn(async () => true),
		notify: vi.fn(),
		setWidget: vi.fn(),
		custom: vi.fn(),
	};
	return { ctx: { mode: "rpc", ui } as any, ui };
}

function theme() {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
	} as any;
}

function keybindings() {
	const bindings: Record<string, string> = {
		k: "tui.select.up",
		j: "tui.select.down",
		y: "tui.select.confirm",
		x: "tui.select.cancel",
	};
	return {
		matches: (data: string, id: string) => bindings[data] === id,
		getKeys: (id: string) => Object.entries(bindings)
			.filter(([, binding]) => binding === id)
			.map(([key]) => key),
	} as any;
}

function tuiContext() {
	let component: any;
	const tui = { requestRender: vi.fn() };
	const ui = {
		custom: vi.fn((builder: any) => new Promise((resolve) => {
			component = builder(tui, theme(), keybindings(), resolve);
		})),
		select: vi.fn(),
		confirm: vi.fn(),
		notify: vi.fn(),
		setWidget: vi.fn(),
	};
	return { ctx: { mode: "tui", ui } as any, ui, tui, component: () => component };
}

const localView: SkillMenuView = {
	kind: "local",
	rows: [
		{ name: "alpha", installed: true },
		{ name: "long-name", installed: false },
	],
	updateAllCount: 0,
};

const checkedView: SkillMenuView = {
	kind: "checked",
	rows: [{ name: "alpha", installed: true, status: "behind", commitsBehind: 2 }],
	updateAllCount: 1,
};

describe("createPiSkillUpdateInteraction", () => {
	it("renders aligned local and checked rows and maps semantic menu values", async () => {
		const local = rpcContext(["alpha      installed locally"]);
		await expect(createPiSkillUpdateInteraction(local.ctx).chooseSkill(localView, vi.fn()))
			.resolves.toEqual({ kind: "open-skill", name: "alpha" });
		expect(local.ui.select).toHaveBeenCalledWith("update-skill — which skill?", [
			"alpha      installed locally",
			"long-name  not installed",
			"* Check now (fetch upstream)",
			"Cancel",
		]);

		const checked = rpcContext(["* Update all (1)"]);
		await expect(createPiSkillUpdateInteraction(checked.ctx).chooseSkill(checkedView, vi.fn()))
			.resolves.toEqual({ kind: "update-all" });
		expect((checked.ui.select.mock.calls as unknown[][])[0][1]).toEqual([
			"* Update all (1)",
			"alpha  2 commits behind",
			"* Check now (fetch upstream)",
			"Cancel",
		]);
	});

	it("consumes Check now once, clears the fallback widget, and uses the replacement view", async () => {
		const { ctx, ui } = rpcContext(["* Check now (fetch upstream)", "* Update all (1)"]);
		const refresh = vi.fn(async () => ({ view: checkedView, completion: "complete" as const }));

		await expect(createPiSkillUpdateInteraction(ctx).chooseSkill(localView, refresh))
			.resolves.toEqual({ kind: "update-all" });

		expect(refresh).toHaveBeenCalledOnce();
		expect(ui.setWidget.mock.calls.at(-1)).toEqual(["update-skill", undefined]);
		expect(ui.select).toHaveBeenCalledTimes(2);
	});

	it("clears fallback widgets on refresh and preparation rejection", async () => {
		const refreshContext = rpcContext(["* Check now (fetch upstream)"]);
		await expect(createPiSkillUpdateInteraction(refreshContext.ctx).chooseSkill(
			localView,
			async () => { throw new Error("offline"); },
		)).rejects.toThrow("offline");
		expect(refreshContext.ui.setWidget.mock.calls.at(-1)).toEqual(["update-skill", undefined]);

		const actionContext = rpcContext(["Install"]);
		await expect(createPiSkillUpdateInteraction(actionContext.ctx).chooseAction(
			{ name: "alpha", actions: ["install"], requiresPreparation: true },
			async () => { throw new Error("offline"); },
		)).rejects.toThrow("offline");
		expect(actionContext.ui.setWidget.mock.calls.at(-1)).toEqual(["update-skill", undefined]);
	});

	it("maps action labels and prepares only Install or Update", async () => {
		const prepared = rpcContext(["Update"]);
		const prepare = vi.fn(async () => {});
		await expect(createPiSkillUpdateInteraction(prepared.ctx).chooseAction(
			{ name: "alpha", actions: ["update", "uninstall"], requiresPreparation: true },
			prepare,
		)).resolves.toEqual({ kind: "update" });
		expect(prepared.ui.select).toHaveBeenCalledWith("alpha — action", [
			"Update",
			"Uninstall",
			"Back",
		]);
		expect(prepare).toHaveBeenCalledOnce();

		const back = rpcContext([undefined]);
		await expect(createPiSkillUpdateInteraction(back.ctx).chooseAction(
			{ name: "alpha", actions: ["install"], requiresPreparation: true },
			prepare,
		)).resolves.toEqual({ kind: "back" });
		expect(prepare).toHaveBeenCalledOnce();
	});

	it("renders every confirmation variant with the existing prose", async () => {
		const { ctx, ui } = rpcContext();
		const adapter = createPiSkillUpdateInteraction(ctx);
		await adapter.confirm({
			kind: "install",
			name: "alpha",
			sourceId: "source",
			sourcePath: "skills/alpha",
		});
		await adapter.confirm({ kind: "uninstall", name: "alpha" });
		await adapter.confirm({
			kind: "update-all",
			skills: [
				{ name: "alpha", status: "behind", commitsBehind: 1 },
				{ name: "beta", status: "not-installed", commitsBehind: 0 },
			],
		});
		await adapter.confirm({
			kind: "update",
			name: "alpha",
			sourceId: "source",
			branch: "main",
			commitsBehind: 0,
		});

		expect(ui.confirm.mock.calls).toEqual([
			["Install alpha?", "Copy skills/alpha from source into .pi/skills/alpha/"],
			["Uninstall alpha?", "Delete the local copy at .pi/skills/alpha/?"],
			["Update all (2)?", "Installing/updating:\n  alpha (1 commit behind)\n  beta (not installed)"],
			["Update alpha?", "Replace the local copy with source's latest main version."],
		]);
	});

	it("renders normalized preview sections, caps, and truncation exactly", async () => {
		const { ctx, ui } = rpcContext();
		const commits = Array.from({ length: 15 }, (_, index) => `${index} change`);
		const diff = Array.from({ length: 30 }, (_, index) => `line ${index}`);
		await createPiSkillUpdateInteraction(ctx).confirm({
			kind: "update",
			name: "alpha",
			sourceId: "source",
			branch: "main",
			commitsBehind: 2,
			preview: {
				commitLines: commits,
				changedFileLines: ["x | 1 +"],
				skillMarkdownDiffLines: diff,
				totalCommits: 16,
				truncated: true,
			},
		});

		const [title, message] = (ui.confirm.mock.calls as unknown[][])[0];
		expect(title).toBe("Update alpha? (2 commits behind)");
		expect(message).toContain("Commits (16):\n  0 change");
		expect(message).toContain("  14 change");
		expect(message).toContain("Changed files:\n  x | 1 +");
		expect(message).toContain("line 29\n… (diff truncated)");
		expect(message).not.toContain("15 change");
	});

	it("maps every notice to its exact text and severity", () => {
		const { ctx, ui } = rpcContext();
		const adapter = createPiSkillUpdateInteraction(ctx);
		const notices: SkillUpdateNotice[] = [
			{ kind: "check-warning" },
			{ kind: "installed", name: "alpha" },
			{ kind: "updated", name: "alpha" },
			{ kind: "uninstalled", name: "alpha" },
			{ kind: "update-all-complete", names: ["alpha", "beta"] },
			{ kind: "removed-upstream", name: "alpha" },
			{ kind: "already-current", name: "alpha" },
			{ kind: "preview-failure", name: "alpha", error: "boom" },
			{ kind: "apply-failure", name: "alpha", error: "boom" },
		];
		for (const notice of notices) adapter.report(notice);

		expect(ui.notify.mock.calls).toEqual([
			["update-skill: upstream check failed — showing last known status", "warning"],
			["update-skill: installed alpha", "info"],
			["update-skill: updated alpha", "info"],
			["update-skill: uninstalled alpha", "info"],
			["update-skill: alpha, beta updated", "info"],
			["update-skill: alpha was removed upstream; uninstall it instead", "warning"],
			["update-skill: alpha is already up to date", "info"],
			["update-skill: could not build the preview for alpha (boom)", "error"],
			["update-skill: failed to update alpha (boom)", "error"],
		]);
	});

	it("keeps the TUI menu mounted through refresh and returns a rebuilt semantic value", async () => {
		const harness = tuiContext();
		const refresh = vi.fn(async () => ({ view: checkedView, completion: "complete" as const }));
		const pending = createPiSkillUpdateInteraction(harness.ctx).chooseSkill(localView, refresh);
		const component = harness.component();
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");
		component.handleInput("\r");
		expect(refresh).toHaveBeenCalledOnce();
		component.handleInput("\u001b");
		await vi.waitFor(() => expect(harness.tui.requestRender).toHaveBeenCalledTimes(4));
		expect(component.render(80).join("\n")).toContain("Upstream check complete.");

		component.handleInput("\u001b[A");
		component.handleInput("\u001b[A");
		component.handleInput("\r");
		await expect(pending).resolves.toEqual({ kind: "update-all" });
		for (const width of [1, 8, 40]) {
			expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
		}
		expect(() => component.invalidate()).not.toThrow();
	});

	it("keeps the TUI action selector mounted after preparation failure", async () => {
		const harness = tuiContext();
		const pending = createPiSkillUpdateInteraction(harness.ctx).chooseAction(
			{ name: "alpha", actions: ["install"], requiresPreparation: true },
			async () => { throw new Error("offline"); },
		);
		const component = harness.component();
		component.handleInput("\r");
		await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Check failed: offline"));
		component.handleInput("\u001b");
		await expect(pending).resolves.toEqual({ kind: "back" });
	});
});
