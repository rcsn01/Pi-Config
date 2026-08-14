import { parse, type Comment, type ControlOperator, type GlobPattern } from "shell-quote";

export type BashPolicyResult =
	| { allowed: true }
	| { allowed: false; reason: string; command?: string };

const VARIABLE_PREFIX = "\u{E000}PLAN_VAR:";
const VARIABLE_SUFFIX = "\u{E001}";
const VARIABLE_PATTERN = /\u{E000}PLAN_VAR:([A-Za-z_][A-Za-z0-9_]*)\u{E001}/gu;
const ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SAFE_OPERATORS = new Set([";", "&&", "||", "|"]);
const BASIC_READERS = new Set([
	"cat", "du", "file", "grep", "head", "ls", "printf", "pwd", "tail", "wc",
]);
const SENSITIVE_VARIABLE = /^(?:PATH|IFS|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|ENVIRONMENT|GLOBIGNORE|PROMPT_COMMAND|PS4|PAGER|MANPAGER|SYSTEMD_PAGER|RIPGREP_CONFIG_PATH|GREP_OPTIONS|PYTEST_ADDOPTS|LD_.+|DYLD_.+|NODE_.+|RUBY.+|PERL.+|PYTHON.+|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|GIT_.+|CARGO_.+|RUSTC_.+|RUSTDOC_.+)$/;
const VARIABLE_SUBCOMMAND_TOOLS = new Set(["bun", "cargo", "deno", "go", "git", "npm", "pnpm", "python", "yarn"]);

interface PolicyCommand {
	words: string[];
	index: number;
}

type ParsedToken = string | ControlOperator | GlobPattern | Comment;

function reject(reason: string, command?: string): BashPolicyResult {
	return { allowed: false, reason, ...(command ? { command } : {}) };
}

function commandReject(command: PolicyCommand, reason: string): BashPolicyResult {
	return reject(`Plan Mode blocked command ${command.index}: ${reason}`, command.words[0]);
}

/** Reject syntax that shell-quote either expands or does not diagnose reliably. */
function lexicalPreflight(command: string): string | undefined {
	if (/[\r\n]/.test(command)) return "Plan Mode Bash does not support multiline scripts or heredocs.";

	let quote: "'" | '"' | undefined;
	let escaped = false;
	let atWordStart = true;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		const next = command[index + 1] ?? "";

		if (escaped) {
			escaped = false;
			atWordStart = false;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote === '"') {
			if (char === '"') {
				quote = undefined;
				continue;
			}
			if (char === "`" || (char === "$" && next === "(")) {
				return "Plan Mode Bash does not support command or arithmetic substitution.";
			}
			continue;
		}
		if (char === "'") {
			quote = "'";
			atWordStart = false;
			continue;
		}
		if (char === '"') {
			quote = '"';
			atWordStart = false;
			continue;
		}
		if (char === "#") {
			if (atWordStart) break;
			return "Plan Mode Bash requires literal # characters to be quoted.";
		}
		if (char === "`" || (char === "$" && next === "(")) {
			return "Plan Mode Bash does not support command or arithmetic substitution.";
		}
		if (char === "$" && (next === "{" || /[A-Za-z_]/.test(next))) {
			return "Plan Mode Bash requires variable references to be double-quoted to prevent field splitting and glob expansion.";
		}
		if ((char === "<" || char === ">") && next === "(") {
			return "Plan Mode Bash does not support process substitution.";
		}
		if (char === "<" || char === ">") {
			return "Plan Mode Bash does not support input/output redirection or heredocs.";
		}
		if (char === "&") {
			if (next !== "&") return "Plan Mode Bash does not support background jobs or coprocess pipelines.";
			index++;
			atWordStart = true;
			continue;
		}
		if (char === "|" && next === "&") {
			return "Plan Mode Bash does not support background jobs or coprocess pipelines.";
		}
		if (char === "(" || char === ")") {
			return "Plan Mode Bash does not support subshells or shell functions.";
		}
		atWordStart = /\s/.test(char) || char === ";" || char === "|" || char === "&";
	}
	if (quote) return "Plan Mode Bash rejected malformed quoting.";
	if (escaped) return "Plan Mode Bash rejected a trailing escape character.";
	return undefined;
}

function hasVariable(value: string): boolean {
	return value.includes(VARIABLE_PREFIX);
}

function expandKnownVariables(value: string, variables: Map<string, string>): string | undefined {
	let unknown = false;
	const expanded = value.replace(VARIABLE_PATTERN, (_marker, name: string) => {
		const replacement = variables.get(name);
		if (replacement === undefined) {
			unknown = true;
			return "";
		}
		return replacement;
	});
	return unknown ? undefined : expanded;
}

function optionIs(argument: string, option: string): boolean {
	return argument === option || argument.startsWith(`${option}=`);
}

function validateFind(command: PolicyCommand, args: string[]): BashPolicyResult | undefined {
	const denied = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf"];
	for (const argument of args) {
		if (denied.some((option) => argument === option || argument.startsWith(`${option}=`))) {
			return commandReject(command, `find option "${argument}" can mutate or write files.`);
		}
	}
	return undefined;
}

function validateSed(command: PolicyCommand, args: string[]): BashPolicyResult | undefined {
	const option = args.find((argument) => argument === "--in-place" || argument.startsWith("--in-place=") || /^-i(?:.|$)/.test(argument));
	return option ? commandReject(command, `sed option "${option}" edits files in place.`) : undefined;
}

function validateTree(command: PolicyCommand, args: string[]): BashPolicyResult | undefined {
	const option = args.find((argument) => argument === "-o" || /^-o.+/.test(argument) || optionIs(argument, "--output"));
	return option ? commandReject(command, `tree option "${option}" writes output to a file.`) : undefined;
}

function validateRg(command: PolicyCommand, args: string[]): BashPolicyResult | undefined {
	const option = args.find((argument) => optionIs(argument, "--pre") || optionIs(argument, "--pre-glob") || optionIs(argument, "--hostname-bin"));
	return option ? commandReject(command, `rg option "${option}" may execute another command.`) : undefined;
}

const GIT_SUBCOMMANDS = new Set(["branch", "diff", "grep", "log", "ls-files", "show", "status"]);
const GIT_GLOBAL_FLAGS = new Set(["--no-pager", "--paginate", "-p", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-replace-objects", "--bare"]);
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const GIT_BRANCH_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--list", "-l", "--ignore-case", "-i", "--no-column"]);
const GIT_BRANCH_VALUE_OPTIONS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort", "--column", "--color", "--abbrev"]);

function validateGitBranch(command: PolicyCommand, args: string[]): BashPolicyResult | undefined {
	let listing = args.includes("--list") || args.includes("-l");
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (GIT_BRANCH_FLAGS.has(argument)) continue;
		const withEquals = [...GIT_BRANCH_VALUE_OPTIONS].find((option) => argument.startsWith(`${option}=`));
		if (withEquals) continue;
		if (GIT_BRANCH_VALUE_OPTIONS.has(argument)) {
			if (++index >= args.length) return commandReject(command, `git branch option "${argument}" requires a value.`);
			continue;
		}
		if (listing && !argument.startsWith("-")) continue;
		return commandReject(command, `git branch argument "${argument}" is not a listing/query form.`);
	}
	return undefined;
}

function validateGit(command: PolicyCommand, args: string[]): BashPolicyResult | undefined {
	for (const argument of args) {
		if (argument === "-c" || /^-c.+/.test(argument) || optionIs(argument, "--config-env")) {
			return commandReject(command, `git option "${argument}" can inject executable configuration.`);
		}
		if (argument === "--ext-diff" || argument === "--textconv" || optionIs(argument, "--output") || optionIs(argument, "--open-files-in-pager")) {
			return commandReject(command, `git option "${argument}" may execute a command or write a file.`);
		}
	}

	let index = 0;
	while (index < args.length) {
		const argument = args[index];
		if (GIT_GLOBAL_FLAGS.has(argument)) {
			index++;
			continue;
		}
		if (GIT_GLOBAL_VALUE_OPTIONS.has(argument)) {
			index += 2;
			continue;
		}
		if ([...GIT_GLOBAL_VALUE_OPTIONS].some((option) => argument.startsWith(`${option}=`))) {
			index++;
			continue;
		}
		break;
	}
	const subcommand = args[index];
	if (!subcommand) return commandReject(command, "git requires an approved inspection subcommand.");
	if (hasVariable(subcommand)) return commandReject(command, "a variable-derived git subcommand is not allowed.");
	if (!GIT_SUBCOMMANDS.has(subcommand)) return commandReject(command, `git subcommand "${subcommand}" is not an approved inspection command.`);
	const subcommandArgs = args.slice(index + 1);
	return subcommand === "branch" ? validateGitBranch(command, subcommandArgs) : undefined;
}

function exactPrefix(args: string[], prefix: string[]): boolean {
	return prefix.every((word, index) => args[index] === word);
}

function validateApprovedTool(command: PolicyCommand, executable: string, args: string[]): BashPolicyResult | undefined {
	if (executable === "printf") {
		const option = args.find((argument) => argument === "-v" || argument.startsWith("-v"));
		return option ? commandReject(command, `printf option "${option}" can assign shell variables.`) : undefined;
	}
	if (BASIC_READERS.has(executable)) return undefined;
	if (executable === "find") return validateFind(command, args);
	if (executable === "sed") return validateSed(command, args);
	if (executable === "tree") return validateTree(command, args);
	if (executable === "rg") return validateRg(command, args);
	if (executable === "git") return validateGit(command, args);

	const approved =
		(executable === "bun" && (args[0] === "test" || args[0] === "--check")) ||
		(executable === "cargo" && (args[0] === "check" || args[0] === "test")) ||
		(executable === "deno" && args[0] === "check") ||
		(executable === "go" && args[0] === "test") ||
		(executable === "pytest") ||
		(executable === "python" && exactPrefix(args, ["-m", "pytest"])) ||
		(executable === "tsc") ||
		((executable === "npm" || executable === "pnpm") && (
			args[0] === "test" || (args[0] === "run" && ["build", "check", "lint", "test", "typecheck"].includes(args[1]))
		)) ||
		(executable === "yarn" && ["test", "build", "lint", "typecheck"].includes(args[0]));
	if (approved) return undefined;
	return commandReject(command, `"${executable}" is not an approved inspection command or check invocation.`);
}

function evaluateCommand(command: PolicyCommand, variables: Map<string, string>): BashPolicyResult | undefined {
	if (command.words.length === 1) {
		const assignment = ASSIGNMENT_PATTERN.exec(command.words[0]);
		if (assignment) {
			const [, name, rawValue] = assignment;
			if (SENSITIVE_VARIABLE.test(name)) return commandReject(command, `assignment to shell-sensitive variable "${name}" is not allowed.`);
			const value = expandKnownVariables(rawValue, variables);
			if (value === undefined) return commandReject(command, `assignment "${name}" references an unknown variable.`);
			variables.set(name, value);
			return undefined;
		}
	}
	if (command.words.some((word) => ASSIGNMENT_PATTERN.test(word))) {
		return commandReject(command, "environment-prefix execution is not allowed; put a scratch assignment in its own command first.");
	}

	const executable = command.words[0];
	if (hasVariable(executable)) return commandReject(command, "a variable-derived executable is not allowed.");
	if (executable === "{" || executable === "}" || ["eval", "source", ".", "bash", "sh", "zsh", "fish", "node", "ruby", "perl"].includes(executable)) {
		return commandReject(command, `"${executable}" is an unsupported shell construct or interpreter.`);
	}

	const rawArgs = command.words.slice(1);
	if (VARIABLE_SUBCOMMAND_TOOLS.has(executable) && hasVariable(rawArgs[0] ?? "")) {
		const subject = executable === "git" ? "git subcommand" : `${executable} subcommand`;
		return commandReject(command, `a variable-derived ${subject} is not allowed.`);
	}
	const args: string[] = [];
	for (const argument of rawArgs) {
		const expanded = expandKnownVariables(argument, variables);
		if (expanded === undefined) return commandReject(command, `argument references an unknown or unsupported variable.`);
		args.push(expanded);
	}
	return validateApprovedTool(command, executable, args);
}

export function evaluatePlanBash(command: string): BashPolicyResult {
	if (!command.trim()) return { allowed: true };
	const lexicalError = lexicalPreflight(command);
	if (lexicalError) return reject(`${lexicalError} Use simpler Bash or native read/search tools instead.`);

	let tokens: ParsedToken[];
	try {
		tokens = parse(command, (name) => `${VARIABLE_PREFIX}${name}${VARIABLE_SUFFIX}`) as ParsedToken[];
	} catch (error) {
		return reject(`Plan Mode Bash could not parse this command: ${error instanceof Error ? error.message : String(error)}. Split it into simpler inspection commands.`);
	}

	const commands: PolicyCommand[] = [];
	let words: string[] = [];
	let lastOperator: string | undefined;
	const finishCommand = () => {
		if (words.length > 0) commands.push({ words, index: commands.length + 1 });
		words = [];
	};

	for (const token of tokens) {
		if (typeof token === "object" && "comment" in token) break;
		if (typeof token === "object" && "op" in token && token.op !== "glob") {
			if (!SAFE_OPERATORS.has(token.op)) return reject(`Plan Mode Bash does not support shell operator "${token.op}". Use simpler Bash or native read/search tools instead.`);
			if (words.length === 0) return reject(`Plan Mode Bash rejected an empty command near "${token.op}".`);
			finishCommand();
			lastOperator = token.op;
			continue;
		}
		if (typeof token === "object" && "op" in token && token.op === "glob") {
			return reject("Plan Mode Bash does not support unquoted glob expansion. Quote the pattern or use native search tools instead.");
		} else if (typeof token === "string") {
			words.push(token);
		}
		lastOperator = undefined;
	}
	finishCommand();
	if (lastOperator && lastOperator !== ";") return reject(`Plan Mode Bash rejected a trailing "${lastOperator}" operator.`);
	if (commands.length === 0) return { allowed: true };

	const variables = new Map<string, string>();
	for (const policyCommand of commands) {
		const result = evaluateCommand(policyCommand, variables);
		if (result) return result;
	}
	return { allowed: true };
}
