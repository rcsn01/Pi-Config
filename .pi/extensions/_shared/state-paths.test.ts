import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { projectStateId, projectStateRoot } from "./state-paths.ts";

describe("project state paths", () => {
	it("uses an explicit state directory and stable project hash", () => {
		const first = projectStateRoot(path.join("workspace", "one"), { stateDir: path.join("state", "root") });
		const second = projectStateRoot(path.join("workspace", "one"), { stateDir: path.join("state", "root") });
		expect(first).toBe(second);
		expect(path.dirname(first)).toBe(path.resolve("state", "root"));
		expect(path.basename(first)).toMatch(/^[a-f0-9]{16}$/);
	});

	it("separates distinct project roots", () => {
		expect(projectStateId(path.join("workspace", "one"))).not.toBe(
			projectStateId(path.join("workspace", "two")),
		);
	});

	it("defaults below the user Pi state directory", () => {
		const root = projectStateRoot(path.join("workspace", "one"), { homeDir: path.resolve("test-home") });
		expect(root.startsWith(path.join(path.resolve("test-home"), ".pi", "state", "pi-config"))).toBe(true);
	});
});