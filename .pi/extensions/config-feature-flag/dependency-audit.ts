import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "@babel/parser";
import type { ExtensionCatalog } from "./catalog.ts";

export type DependencyKind = "import" | "required-service" | "child-runtime";

export interface DependencyEvidence {
	consumer: string;
	provider: string;
	kind: DependencyKind;
	sourcePath: string;
	line: number;
}

export interface ExtensionSource {
	extensionId: string;
	absolutePath: string;
	sourcePath: string;
	contents: string;
	extensionRoots: readonly string[];
	knownExtensionIds: ReadonlySet<string>;
}

export const REQUIRED_SERVICE_CONTRACTS = [
	{
		module: "_shared/subagent-service.ts",
		exportName: "requireSubagentService",
		provider: "tools-subagents",
	},
] as const;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXCLUDED_DIRECTORIES = new Set([
	"node_modules",
	"cache",
	".git",
	"tests",
	"__tests__",
	"fixtures",
	"__fixtures__",
]);
const EXCLUDED_FILE = /(?:^test-harness\.ts$|\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$|\.d\.(?:ts|tsx)$)/;

type AstNode = {
	type: string;
	loc?: { start: { line: number } } | null;
	[key: string]: unknown;
};

export function discoverExtensionSources(repositoryRoot: string): ExtensionSource[] {
	const extensionRoots = [
		path.join(repositoryRoot, ".pi", "extensions"),
		path.join(repositoryRoot, ".pi", "extensions-disabled"),
	];
	const owners = new Map<string, string>();

	for (const root of extensionRoots) {
		if (!fs.existsSync(root)) continue;
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !fs.existsSync(path.join(root, entry.name, "index.ts"))) continue;
			const existing = owners.get(entry.name);
			if (existing !== undefined) {
				throw new Error(
					`Extension "${entry.name}" exists in both "${displayPath(repositoryRoot, existing)}" and "${displayPath(repositoryRoot, path.join(root, entry.name))}".`,
				);
			}
			owners.set(entry.name, path.join(root, entry.name));
		}
	}

	const knownExtensionIds = new Set(owners.keys());
	const sources: ExtensionSource[] = [];
	for (const [extensionId, ownerRoot] of [...owners].sort(([left], [right]) => left.localeCompare(right))) {
		walkSourceFiles(ownerRoot, (absolutePath) => {
			sources.push({
				extensionId,
				absolutePath,
				sourcePath: displayPath(repositoryRoot, absolutePath),
				contents: fs.readFileSync(absolutePath, "utf8"),
				extensionRoots,
				knownExtensionIds,
			});
		});
	}
	return sources.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

export function collectDependencyEvidence(sources: readonly ExtensionSource[]): DependencyEvidence[] {
	const evidence: DependencyEvidence[] = [];

	for (const source of sources) {
		let ast: AstNode;
		try {
			ast = parse(source.contents, {
				sourceType: "unambiguous",
				plugins: ["typescript", "jsx"],
			}) as unknown as AstNode;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot parse "${source.sourcePath}": ${detail}`);
		}

		const namespaceAccessors = collectServiceImports(ast, source, evidence);
		visitAst(ast, (node) => {
			const specifier = importSpecifier(node);
			if (specifier !== undefined) {
				addImportEvidence(source, specifier, lineOf(node), evidence);
			}
			if (isRequiredNamespaceCall(node, namespaceAccessors)) {
				const contract = REQUIRED_SERVICE_CONTRACTS[0];
				if (source.extensionId !== contract.provider) {
					evidence.push(makeEvidence(source, contract.provider, "required-service", lineOf(node)));
				}
			}
		});

		if (source.extensionId === "tools-subagents" && normalized(source.absolutePath).endsWith("/child-execution.ts")) {
			collectChildRuntimeEvidence(ast, source, evidence);
		}
	}

	return deduplicateAndSort(evidence);
}

export function validateDependencyEvidence(
	catalog: ExtensionCatalog,
	evidence: readonly DependencyEvidence[],
): string[] {
	const diagnostics = evidence
		.filter(({ consumer, provider }) => !catalog.extensions[consumer]?.requires.includes(provider))
		.map(({ consumer, provider, kind, sourcePath, line }) =>
			`${consumer} -> ${provider} (${kind}) at ${normalized(sourcePath)}:${line}: catalog entry "${consumer}" must declare "${provider}" in requires.`,
		);
	return [...new Set(diagnostics)].sort();
}

function walkSourceFiles(directory: string, onFile: (absolutePath: string) => void): void {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		const absolutePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!EXCLUDED_DIRECTORIES.has(entry.name)) walkSourceFiles(absolutePath, onFile);
			continue;
		}
		if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name)) || EXCLUDED_FILE.test(entry.name)) continue;
		onFile(absolutePath);
	}
}

function collectServiceImports(
	ast: AstNode,
	source: ExtensionSource,
	evidence: DependencyEvidence[],
): Set<string> {
	const namespaces = new Set<string>();
	const program = ast.type === "File" ? asNode(ast.program) : ast;
	const body = Array.isArray(program?.body) ? program.body : [];
	for (const value of body) {
		const node = asNode(value);
		if (node?.type !== "ImportDeclaration" || stringValue(node.source) === undefined) continue;
		const contract = serviceContractForSpecifier(source, stringValue(node.source)!);
		if (contract === undefined || source.extensionId === contract.provider || node.importKind === "type") continue;
		for (const valueSpecifier of Array.isArray(node.specifiers) ? node.specifiers : []) {
			const specifier = asNode(valueSpecifier);
			if (specifier?.type === "ImportSpecifier" && specifier.importKind !== "type" && identifierName(specifier.imported) === contract.exportName) {
				evidence.push(makeEvidence(source, contract.provider, "required-service", lineOf(specifier)));
			}
			if (specifier?.type === "ImportNamespaceSpecifier") {
				const local = identifierName(specifier.local);
				if (local !== undefined) namespaces.add(local);
			}
		}
	}
	return namespaces;
}

function serviceContractForSpecifier(source: ExtensionSource, specifier: string) {
	if (!specifier.startsWith(".")) return undefined;
	const target = normalized(path.resolve(path.dirname(source.absolutePath), specifier));
	return REQUIRED_SERVICE_CONTRACTS.find((contract) => target.endsWith(`/${contract.module}`));
}

function isRequiredNamespaceCall(node: AstNode, namespaces: ReadonlySet<string>): boolean {
	if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return false;
	const callee = asNode(node.callee);
	if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return false;
	return namespaces.has(identifierName(callee.object) ?? "") && identifierName(callee.property) === "requireSubagentService";
}

function importSpecifier(node: AstNode): string | undefined {
	if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
		return stringValue(node.source);
	}
	if (node.type === "ImportExpression") return stringValue(node.source);
	if (node.type !== "CallExpression") return undefined;
	const args = Array.isArray(node.arguments) ? node.arguments : [];
	if (args.length !== 1) return undefined;
	const callee = asNode(node.callee);
	if (callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require")) {
		return stringValue(args[0]);
	}
	return undefined;
}

function addImportEvidence(
	source: ExtensionSource,
	specifier: string,
	line: number,
	evidence: DependencyEvidence[],
): void {
	if (!specifier.startsWith(".")) return;
	const target = path.resolve(path.dirname(source.absolutePath), specifier);
	const provider = ownedExtension(source, target);
	if (provider === undefined || provider === source.extensionId || provider === "_shared") return;
	evidence.push(makeEvidence(source, provider, "import", line));
}

function ownedExtension(source: ExtensionSource, target: string): string | undefined {
	for (const root of source.extensionRoots) {
		const relative = path.relative(root, target);
		if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
		const [candidate] = relative.split(path.sep);
		if (candidate !== undefined && source.knownExtensionIds.has(candidate)) return candidate;
	}
	return undefined;
}

function collectChildRuntimeEvidence(ast: AstNode, source: ExtensionSource, evidence: DependencyEvidence[]): void {
	let declaration: AstNode | undefined;
	visitAst(ast, (node) => {
		if (node.type === "VariableDeclarator" && identifierName(node.id) === "CHILD_RUNTIME_EXTENSIONS") declaration = node;
	});
	if (declaration === undefined) {
		throw new Error(`Cannot audit child runtimes in "${source.sourcePath}": CHILD_RUNTIME_EXTENSIONS is missing.`);
	}
	const initializer = unwrapExpression(asNode(declaration.init));
	if (initializer?.type !== "ArrayExpression") {
		throw new Error(`Cannot audit child runtimes in "${source.sourcePath}": CHILD_RUNTIME_EXTENSIONS must be an array literal, optionally followed by "as const".`);
	}
	for (const elementValue of Array.isArray(initializer.elements) ? initializer.elements : []) {
		const element = unwrapExpression(asNode(elementValue));
		if (element?.type !== "ObjectExpression") throw unsupportedChildRuntime(source);
		const properties = Array.isArray(element.properties) ? element.properties : [];
		const nameProperty = properties.map(asNode).find((property) =>
			property?.type === "ObjectProperty" && !property.computed && identifierName(property.key) === "name",
		);
		const provider = nameProperty === undefined ? undefined : stringValue(nameProperty.value);
		if (provider === undefined) throw unsupportedChildRuntime(source);
		evidence.push(makeEvidence(source, provider, "child-runtime", lineOf(nameProperty!)));
	}
}

function unsupportedChildRuntime(source: ExtensionSource): Error {
	return new Error(`Cannot audit child runtimes in "${source.sourcePath}": every CHILD_RUNTIME_EXTENSIONS entry must be an object with a literal name property.`);
}

function unwrapExpression(node: AstNode | undefined): AstNode | undefined {
	let current = node;
	while (current && ["TSAsExpression", "TSSatisfiesExpression", "TypeCastExpression", "ParenthesizedExpression"].includes(current.type)) {
		current = asNode(current.expression);
	}
	return current;
}

function visitAst(value: unknown, visit: (node: AstNode) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) visitAst(item, visit);
		return;
	}
	const node = asNode(value);
	if (node === undefined) return;
	visit(node);
	for (const [key, child] of Object.entries(node)) {
		if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
		visitAst(child, visit);
	}
}

function makeEvidence(source: ExtensionSource, provider: string, kind: DependencyKind, line: number): DependencyEvidence {
	return { consumer: source.extensionId, provider, kind, sourcePath: normalized(source.sourcePath), line };
}

function deduplicateAndSort(evidence: readonly DependencyEvidence[]): DependencyEvidence[] {
	const keyed = new Map<string, DependencyEvidence>();
	for (const item of evidence) {
		const key = [item.consumer, item.provider, item.kind, normalized(item.sourcePath), item.line].join("\0");
		keyed.set(key, { ...item, sourcePath: normalized(item.sourcePath) });
	}
	return [...keyed.values()].sort((left, right) => {
		const textual = [left.consumer, left.provider, left.kind, left.sourcePath]
			.join("\0")
			.localeCompare([right.consumer, right.provider, right.kind, right.sourcePath].join("\0"));
		return textual !== 0 ? textual : left.line - right.line;
	});
}

function asNode(value: unknown): AstNode | undefined {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
		? value as AstNode
		: undefined;
}

function identifierName(value: unknown): string | undefined {
	const node = asNode(value);
	if (node?.type === "Identifier") return typeof node.name === "string" ? node.name : undefined;
	if (node?.type === "StringLiteral") return typeof node.value === "string" ? node.value : undefined;
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	const node = asNode(value);
	return node?.type === "StringLiteral" && typeof node.value === "string" ? node.value : undefined;
}

function lineOf(node: AstNode): number {
	return node.loc?.start.line ?? 1;
}

function displayPath(repositoryRoot: string, absolutePath: string): string {
	return normalized(path.relative(repositoryRoot, absolutePath));
}

function normalized(value: string): string {
	return value.replaceAll("\\", "/");
}
