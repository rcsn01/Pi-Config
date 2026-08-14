import { describe, expect, it } from "vitest";
import { evaluatePlanBash } from "./bash-policy.ts";

function expectAllowed(command: string): void {
	expect(evaluatePlanBash(command), command).toEqual({ allowed: true });
}

function expectBlocked(command: string, reason?: string): void {
	const result = evaluatePlanBash(command);
	expect(result.allowed, command).toBe(false);
	if (!result.allowed && reason) expect(result.reason).toContain(reason);
}

describe("evaluatePlanBash", () => {
	it("allows the reported variable, sequence, and pipeline inspection", () => {
		expectAllowed(`PKG=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent; printf '%s\\n' "$PKG"; find "$PKG" -type f | wc -l; rg 'registerTool|registerCommand' "$PKG" | head -300`);
	});

	it.each([
		"rg foo; head -20 README.md",
		"rg foo && git status",
		"rg foo || find . -name '*.ts'",
		"rg foo | grep bar | head -20 | wc -l",
		`rg 'a;b && c || d | e' "path with spaces"`,
		`printf '%s; %s\\n' 'a && b' 'c | d'`,
		"git status",
		"git --no-pager diff --stat",
		"git branch --show-current",
		"git branch --list 'feature/*'",
		"git log --oneline -10",
		"git ls-files '*.ts'",
		"bun --check index.ts",
		"bun test",
		"cargo check --all-targets",
		"cargo test",
		"deno check index.ts",
		"go test ./...",
		"npm test",
		"npm run typecheck",
		"pnpm run build",
		"pytest -q",
		"python -m pytest -q",
		"tsc --noEmit",
		"yarn lint",
		"",
		"   # inspect this later",
		"rg foo # only this command runs",
	])("allows %s", expectAllowed);

	it("allows standalone scratch assignments as later operands", () => {
		expectAllowed(`PKG='/tmp/a path'; find "$PKG" -type f; rg foo "$PKG"`);
		expectAllowed(`ROOT=/tmp; PKG="$ROOT/a path"; find "$PKG" -type f`);
	});

	it.each([
		["rg foo; rm -rf build", "command 2"],
		["rg foo && touch changed", "command 2"],
		["rg foo || git reset --hard", 'git subcommand "reset"'],
		["rg foo > results.txt", "redirection"],
		["rg foo >> results.txt", "redirection"],
		["cat < input.txt", "redirection"],
		["rg foo | tee results.txt", '"tee"'],
		["find . -delete", "-delete"],
		["find . -exec rm {} \\;", "-exec"],
		["find . -fprintf out '%p\\n'", "-fprintf"],
		["find . -fprint0 out", "-fprint0"],
		["sed -i.bak 's/a/b/' file", "-i.bak"],
		["sed --in-place file", "--in-place"],
		["tree -o tree.txt", '"-o"'],
		["tree --output=tree.txt", "--output"],
		["rg --pre ./filter foo", "--pre"],
		["git branch new-branch", "not a listing/query form"],
		["git diff --output=patch.diff", "--output"],
		["git -c core.pager=cat log", 'git option "-c"'],
		["git diff --ext-diff", "--ext-diff"],
		["CMD=rm; \"$CMD\" -rf build", "variable-derived executable"],
		["git \"$SUBCOMMAND\"", "variable-derived git subcommand"],
		["PATH=/tmp/bin; rg foo", "shell-sensitive variable"],
		["PATH=/tmp/bin rg foo", "environment-prefix"],
		["PAGER='touch changed'; git log", "shell-sensitive variable"],
		["RIPGREP_CONFIG_PATH=/tmp/rg.conf; rg foo", "shell-sensitive variable"],
		["printf -v PATH /tmp/bin; rg foo", "assign shell variables"],
		["find . \"$UNSET\"", "unknown or unsupported variable"],
		["SUBCOMMAND=status; git \"$SUBCOMMAND\"", "variable-derived git subcommand"],
		["X='--pre ./filter'; rg $X foo", "double-quoted"],
		["rg *", "glob expansion"],
		["rg \"$(touch changed)\"", "substitution"],
		["rg `touch changed`", "substitution"],
		["rg <(touch changed)", "process substitution"],
		["rg $((1 + 2))", "substitution"],
		["rg foo &", "background"],
		["rg foo |& head", "coprocess"],
		["(rg foo)", "subshell"],
		["{ rg foo; }", '"{"'],
		["rg 'unterminated", "malformed quoting"],
		["cat <<EOF\nvalue\nEOF", "multiline"],
		["lsmalicious", '"lsmalicious"'],
		["rg-malicious foo", '"rg-malicious"'],
		["git-malicious status", '"git-malicious"'],
		["rg#malicious foo", "literal #"],
		["awk '{ system(\"touch changed\") }' file", '"awk"'],
		["rg foo | touch changed", "command 2"],
		["rg foo && # incomplete", "trailing \"&&\""],
		["rg foo;", ""],
	])("blocks %s", (command, reason) => {
		// A trailing semicolon is valid shell and intentionally remains allowed.
		if (command === "rg foo;") expectAllowed(command);
		else expectBlocked(command, reason || undefined);
	});

	it.each([
		"npm install foo",
		"npm run deploy",
		"pnpm add foo",
		"yarn add foo",
		"bun install",
		"cargo fmt",
		"python script.py",
		"node script.js",
		"eval 'rg foo'",
		"source ./script.sh",
	])("matches only explicitly approved check forms: %s", expectBlocked);
});
