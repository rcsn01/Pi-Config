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
