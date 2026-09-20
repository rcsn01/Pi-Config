import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { DASHBOARD_CLIENT_HELPERS } from "./dashboard-client.ts";

function browserContext() {
	const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
	const context = vm.createContext(window);
	vm.runInContext(`${DASHBOARD_CLIENT_HELPERS}

globalThis.dashboardTestHelpers = {
	guard: dashboardRequiresLifecycle,
	createTablist: dashCreateTablist,
	element: dashElement,
	formatInteger: dashFormatInteger,
	formatCompact: dashFormatCompact,
	selectionMemory: dashCreateSelectionMemory(),
	createListDetailWorkspace: dashCreateListDetailWorkspace,
	formatCost: dashFormatCost,
};`, context);
	return { window, document, helpers: (window as any).dashboardTestHelpers };
}

function keydown(window: any, button: HTMLElement, key: string) {
	const event = new window.Event("keydown", { cancelable: true });
	Object.defineProperty(event, "key", { value: key });
	button.dispatchEvent(event);
	return event;
}

describe("dashboard client shell", () => {
	it("shares safe DOM construction and number formatting", () => {
		const { document, helpers } = browserContext();
		const node = helpers.element("span", "value", "<unsafe>");

		expect(node.tagName).toBe("SPAN");
		expect(node.className).toBe("value");
		expect(node.textContent).toBe("<unsafe>");
		expect(node.innerHTML).not.toContain("<unsafe>");
		expect(helpers.formatInteger(1275)).toBe("1,275");
		expect(helpers.formatCompact(1275)).toBe("1.3k");
		expect(helpers.formatCompact(null)).toBe("0");
		expect(document.body.childElementCount).toBe(0);
	});

	it("builds a data-driven tablist and handles roving keyboard activation", () => {
		const { document, window, helpers } = browserContext();
		const host = document.createElement("nav");
		document.body.append(host);
		const events: Array<[string, boolean]> = [];
		const counts: Record<string, string> = { main: " (2)", other: " (1)", last: "" };
		const tablist = helpers.createTablist({
			host,
			tabs: [
				{ key: "main", label: "Main" },
				{ key: "other", label: "Other" },
				{ key: "last", label: "Last" },
			],
			initialKey: "main",
			buttonClass: "tab",
			ariaLabel: "Views",
			controls: "panel",
			countOf: (key: string) => counts[key],
			onActivate: (tab: { key: string }, details: { focused: boolean }) => events.push([tab.key, details.focused]),
		});
		const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("[role=tab]"));

		expect(host.getAttribute("aria-label")).toBe("Views");
		expect(buttons.map((button) => button.textContent)).toEqual(["Main (2)", "Other (1)", "Last"]);
		expect(buttons.map((button) => [button.id, button.getAttribute("aria-controls"), button.getAttribute("tabindex")])).toEqual([
			["tab-main", "panel", "0"], ["tab-other", "panel", "-1"], ["tab-last", "panel", "-1"],
		]);

		const right = keydown(window, buttons[0]!, "ArrowRight");
		expect(right.defaultPrevented).toBe(true);
		expect(events).toEqual([["other", true]]);
		expect(buttons[1]!.getAttribute("aria-selected")).toBe("true");
		expect(buttons[1]!.getAttribute("tabindex")).toBe("0");
		expect(buttons[0]!.getAttribute("tabindex")).toBe("-1");

		buttons[2]!.dispatchEvent(new window.Event("click"));
		expect(events).toEqual([["other", true], ["last", false]]);
		expect(buttons[2]!.getAttribute("aria-selected")).toBe("true");
		keydown(window, buttons[2]!, "ArrowRight");
		keydown(window, buttons[0]!, "ArrowLeft");
		expect(buttons[2]!.getAttribute("aria-selected")).toBe("true");
		keydown(window, buttons[0]!, "Home");
		keydown(window, buttons[0]!, "End");
		expect(events.slice(-3)).toEqual([["last", true], ["main", true], ["last", true]]);
	});

	it("updates labels and roving state without replacing buttons", () => {
		const { document, helpers } = browserContext();
		const host = document.createElement("nav");
		document.body.append(host);
		const counts: Record<string, string> = { first: " (1)", second: "" };
		const tablist = helpers.createTablist({
			host,
			tabs: [{ key: "first", label: "First" }, { key: "second", label: "Second" }],
			initialKey: "second",
			countOf: (key: string) => counts[key],
			onActivate: () => {},
		});
		const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
		buttons[0]!.click();
		counts.first = " (9)";
		counts.second = " (4)";
		tablist.update();

		expect(Array.from(host.querySelectorAll("button"))).toEqual(buttons);
		expect(buttons.map((button) => button.textContent)).toEqual(["First (9)", "Second (4)"]);
		expect(buttons.map((button) => [button.getAttribute("aria-selected"), button.getAttribute("tabindex")])).toEqual([
			["true", "0"], ["false", "-1"],
		]);
	});

	it("remembers selections per view and falls back without erasing memory", () => {
		const { helpers } = browserContext();
		const memory = helpers.selectionMemory;
		// empty offering returns null and does not touch memory
		expect(memory.keep("guardian", [])).toBeNull();
		memory.store("main", "2:response");
		expect(memory.keep("main", ["2:response", "2:request"])).toBe("2:response");
		// stored choice vanished -> first offered key wins and is persisted
		expect(memory.keep("main", ["5:request", "5:response"])).toBe("5:request");
		// keys[0] wins on a fresh view too: the first offer is the adapter's default
		expect(memory.keep("other", ["5:response", "5:request"])).toBe("5:response");
		// null never erases
		memory.store("main", null);
		expect(memory.keep("main", ["5:request"])).toBe("5:request");
		// views are isolated
		memory.store("sessions", "session-1");
		expect(memory.keep("main", ["5:request"])).toBe("5:request");
		expect(memory.keep("sessions", ["session-9"])).toBe("session-9");
	});

	describe("list/detail workspace", () => {
		function makeWorkspace(overrides: Record<string, unknown> = {}) {
			const { helpers } = browserContext();
			const calls: string[] = [];
			const memory = helpers.selectionMemory;
			const state = { scope: "main", offers: ["5:response", "5:request"] as string[] };
			let selected: string | null = null;
			const workspace = helpers.createListDetailWorkspace({
				memory,
				scopeKey: () => state.scope,
				offers: () => state.offers,
				select: (key: string | null) => { selected = key; calls.push("select:" + key); },
				renderLists: () => calls.push("lists"),
				renderDetail: (ctx: { isCurrent(): boolean; invalidate(): void }) => calls.push("detail:" + ctx.isCurrent()),
				renderEmpty: () => calls.push("empty"),
				...overrides,
			});
			return { helpers, calls, memory, state, workspace, selected: () => selected };
		}

		it("renders the empty phase on an empty offering without touching memory", () => {
			const { calls, memory, workspace } = makeWorkspace({ offers: () => [] });
			memory.store("main", "9:request");
			calls.length = 0;
			workspace.sync();
			expect(calls).toEqual(["select:null", "lists", "empty"]);
			expect(memory.keep("main", ["9:request"])).toBe("9:request");
		});

		it("reconciles an unoffered memory to the first offered key and renders lists before detail", () => {
			const { calls, memory, workspace, selected } = makeWorkspace({ fingerprint: () => selected() });
			memory.store("main", "9:request");
			calls.length = 0;
			workspace.sync();
			expect(calls).toEqual(["select:5:response", "lists", "detail:true"]);
			expect(memory.keep("main", ["5:response", "5:request"])).toBe("5:response");
		});

		it("renders on a forced sync even when the fingerprint would match", () => {
			const { calls, memory, workspace } = makeWorkspace({ fingerprint: () => "f" });
			workspace.sync();
			calls.length = 0;
			workspace.sync("5:request");
			expect(calls).toEqual(["select:5:request", "lists", "detail:true"]);
			expect(memory.keep("main", ["5:request"])).toBe("5:request");
		});

		it("skips an unforced sync when the fingerprint is unchanged and re-renders on change", () => {
			let mark = "f";
			const { calls, workspace } = makeWorkspace({ fingerprint: () => mark });
			workspace.sync();
			workspace.sync();
			expect(calls).toEqual(["select:5:response", "lists", "detail:true", "select:5:response", "lists"]);
			mark = "g";
			workspace.sync();
			expect(calls[calls.length - 1]).toBe("detail:true");
		});

		it("auto-remembers the rendered pair across a scope change", () => {
			const { memory, state, workspace } = makeWorkspace();
			workspace.sync();
			state.scope = "other";
			state.offers = ["7:response"];
			workspace.sync();
			expect(memory.keep("main", ["5:response", "5:request"])).toBe("5:response");
		});

		it("expires the staleness token after a later sync with a different key", () => {
			const { helpers } = browserContext();
			const state = { scope: "main", offers: ["5:response", "5:request"] as string[] };
			let captured: { isCurrent(): boolean } | undefined;
			const workspace = helpers.createListDetailWorkspace({
				memory: helpers.selectionMemory,
				scopeKey: () => state.scope,
				offers: () => state.offers,
				select: () => {},
				renderLists: () => {},
				renderDetail: (ctx: { isCurrent(): boolean }) => { if (!captured) captured = ctx; },
				renderEmpty: () => {},
			});
			workspace.sync();
			expect(captured!.isCurrent()).toBe(true);
			state.offers = ["7:response"];
			workspace.sync();
			expect(captured!.isCurrent()).toBe(false);
		});

		it("re-renders after invalidate() on the next unforced sync", () => {
			let detailCtx: { isCurrent(): boolean; invalidate(): void } | undefined;
			const { calls, workspace } = makeWorkspace({
				fingerprint: () => "f",
				renderDetail: (ctx: { isCurrent(): boolean; invalidate(): void }) => { detailCtx = ctx; calls.push("detail"); },
			});
			workspace.sync();
			detailCtx!.invalidate();
			calls.length = 0;
			workspace.sync();
			expect(calls).toEqual(["select:5:response", "lists", "detail"]);
		});

		it("renders the detail on every unforced sync when the fingerprint is omitted", () => {
			const { calls, workspace } = makeWorkspace();
			workspace.sync();
			workspace.sync();
			expect(calls).toEqual(["select:5:response", "lists", "detail:true", "select:5:response", "lists", "detail:true"]);
		});
	});

	it("formats cost with per-adapter precision", () => {
		const { helpers } = browserContext();
		expect(helpers.formatCost(1.2345)).toBe("$1.234");
		expect(helpers.formatCost(1.2345, 6)).toBe("$1.234500");
		expect(helpers.formatCost(undefined)).toBe("$0.000");
	});

	it("shows the fatal state and disables requested controls when lifecycle is absent", () => {
		const { document, helpers } = browserContext();
		const fatal = document.createElement("div");
		fatal.className = "hidden";
		fatal.setAttribute("hidden", "");
		const content = document.createElement("main");
		const refresh = document.createElement("button");
		refresh.id = "refresh";
		const clear = document.createElement("button");
		clear.id = "clear";
		document.body.append(fatal, content, refresh, clear);

		expect(helpers.guard(null, {
			fatal,
			content,
			message: "Missing token",
			disable: ["refresh", "clear"],
		})).toBe(false);
		expect(fatal.hidden).toBe(false);
		expect(fatal.classList.contains("hidden")).toBe(false);
		expect(fatal.textContent).toBe("Missing token");
		expect(content.hidden).toBe(true);
		expect(refresh.disabled).toBe(true);
		expect(clear.disabled).toBe(true);

		content.hidden = false;
		fatal.textContent = "unchanged";
		expect(helpers.guard({}, { fatal, content, message: "ignored" })).toBe(true);
		expect(fatal.textContent).toBe("unchanged");
		expect(content.hidden).toBe(false);
	});
});
