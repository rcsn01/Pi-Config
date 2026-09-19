import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	evaluateExecPolicy,
	loadExecPolicy,
	loadExecPolicyLayers,
	saveExecPolicy,
	saveProjectExecPolicyRules,
	type ExecPolicyRule,
} from "./command-policy.ts";
import { piConfigPath } from "./pi-config.ts";

let prevRulesFile: string | undefined;
const roots: string[] = [];

afterEach(() => {
	if (prevRulesFile === undefined) delete process.env.PI_EXECPOLICY_FILE;
	else process.env.PI_EXECPOLICY_FILE = prevRulesFile;
	prevRulesFile = undefined;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function withRulesFile(): string {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-execpolicy-")), "execpolicy.json");
	prevRulesFile = process.env.PI_EXECPOLICY_FILE;
	process.env.PI_EXECPOLICY_FILE = file;
	return file;
}

function project(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-execpolicy-project-"));
	roots.push(root);
	return root;
}

const GLOBAL_RULE: ExecPolicyRule = { id: "1", pattern: "curl", action: "prompt", reason: "network" };
const PROJECT_RULE: ExecPolicyRule = { id: "1", pattern: "^pnpm test", action: "allow", reason: "project test runner" };

describe("exec policy layers", () => {
	it("loads global rules without a project layer", () => {
		const file = withRulesFile();
		saveExecPolicy({ rules: [GLOBAL_RULE], defaultAction: "prompt" });
		expect(fs.existsSync(file)).toBe(true);

		expect(loadExecPolicy()).toEqual({ rules: [GLOBAL_RULE], defaultAction: "prompt" });
		expect(loadExecPolicy({ cwd: project(), projectTrusted: true })).toEqual({
			rules: [GLOBAL_RULE],
			defaultAction: "prompt",
		});
	});

	it("appends trusted project rules after global rules", () => {
		withRulesFile();
		saveExecPolicy({ rules: [GLOBAL_RULE], defaultAction: "prompt" });
		const cwd = project();
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ execPolicy: { rules: [PROJECT_RULE] } }));

		const config = loadExecPolicy({ cwd, projectTrusted: true });
		expect(config.rules).toEqual([GLOBAL_RULE, PROJECT_RULE]);
		expect(config.defaultAction).toBe("prompt");
	});

	it("global rules win on overlap; project rules fill the gaps", () => {
		withRulesFile();
		saveExecPolicy({ rules: [{ id: "1", pattern: "curl", action: "block", reason: "no network" }], defaultAction: "allow" });
		const cwd = project();
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({
			execPolicy: { rules: [{ id: "2", pattern: "curl.*--head", action: "allow", reason: "head requests" } satisfies ExecPolicyRule] },
		}));

		const config = loadExecPolicy({ cwd, projectTrusted: true });
		expect(evaluateExecPolicy("curl example.com", config).action).toBe("block");
		expect(evaluateExecPolicy("curl -I example.com", config).action).toBe("block");
		expect(evaluateExecPolicy("pnpm test", config)).toEqual({
			matched: false,
			action: "allow",
		});
	});

	it("filters invalid project rules", () => {
		withRulesFile();
		const cwd = project();
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({
			execPolicy: {
				rules: [
					PROJECT_RULE,
					{ id: "2", pattern: "x", action: "nuke", reason: "bad action" },
					{ id: "3", pattern: "x", action: "allow" },
					{ id: "4", action: "allow", reason: "no pattern" },
					"not an object",
				],
			},
		}));

		expect(loadExecPolicy({ cwd, projectTrusted: true }).rules).toEqual([PROJECT_RULE]);
	});

	it("ignores the project layer for untrusted projects", () => {
		withRulesFile();
		const cwd = project();
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ execPolicy: { rules: [PROJECT_RULE] } }));

		expect(loadExecPolicy({ cwd }).rules).toEqual([]);
		expect(loadExecPolicy({ cwd, projectTrusted: false }).rules).toEqual([]);
	});

	it("tolerates a missing or corrupt global file", () => {
		const file = withRulesFile();
		expect(loadExecPolicy()).toEqual({ rules: [], defaultAction: "allow" });
		fs.writeFileSync(file, "{ not json");
		expect(loadExecPolicy()).toEqual({ rules: [], defaultAction: "allow" });
	});

	it("saveProjectExecPolicyRules writes the namespace and preserves siblings", () => {
		withRulesFile();
		const cwd = project();
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ profile: "research", permissions: { mode: "default" } }));

		saveProjectExecPolicyRules(cwd, [PROJECT_RULE], true);

		expect(JSON.parse(fs.readFileSync(piConfigPath(cwd), "utf-8"))).toEqual({
			profile: "research",
			permissions: { mode: "default" },
			execPolicy: { rules: [PROJECT_RULE] },
		});
		expect(loadExecPolicyLayers({ cwd, projectTrusted: true }).project).toEqual([PROJECT_RULE]);
	});
});