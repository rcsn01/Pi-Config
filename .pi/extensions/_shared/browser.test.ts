import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openInBrowser } from "./browser.ts";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ once: vi.fn(), unref: vi.fn() })),
}));

const spawnMock = vi.mocked(spawn);
const realPlatform = process.platform;

function setPlatform(platform: string) {
	Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
	setPlatform(realPlatform);
	vi.clearAllMocks();
});

describe("default browser opener", () => {
	it("spawns the platform opener directly with the URL", () => {
		setPlatform("darwin");
		openInBrowser("http://localhost:1/#token=secret");
		expect(spawnMock).toHaveBeenCalledWith("open", ["http://localhost:1/#token=secret"], expect.objectContaining({
			detached: true,
			stdio: "ignore",
		}));
	});

	it("uses cmd start with an empty window title on Windows", () => {
		setPlatform("win32");
		openInBrowser("http://localhost:1/#token=secret");
		expect(spawnMock).toHaveBeenCalledWith("cmd", ["/c", "start", "", "http://localhost:1/#token=secret"], expect.anything());
	});

	it("does nothing on platforms without a known opener", () => {
		setPlatform("freebsd");
		openInBrowser("http://localhost:1/#token=secret");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("swallows synchronous spawn failures and async opener errors", () => {
		setPlatform("linux");
		spawnMock.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		expect(() => openInBrowser("http://localhost:1/#token=secret")).not.toThrow();
		spawnMock.mockImplementationOnce(() => {
			const child: any = { once: vi.fn(), unref: vi.fn() };
			child.once.mockImplementation((_event: string, callback: () => void) => callback());
			return child;
		});
		expect(() => openInBrowser("http://localhost:1/#token=secret")).not.toThrow();
	});
});