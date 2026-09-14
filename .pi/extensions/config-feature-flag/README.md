# Extension dependency catalog

`catalog.json` records which extensions may run together. The `/features` command uses it when validating a proposed selection. Dependency source scanning runs only in tests. Pi startup and `/features` do not parse extension source files.

## Declaring a hard dependency

Add the provider extension ID to the consumer's direct `requires` array in `.pi/extensions/catalog.json`. Declare the direct edge even if another requirement also depends on that provider. The catalog parser rejects unknown IDs, self-references, duplicate relationships, and requirement cycles.

Run the focused checks from `.pi`:

```sh
pnpm exec vitest run extensions/config-feature-flag
pnpm test:features
```

The source audit reads production `.ts`, `.tsx`, `.js`, `.mjs`, and `.cjs` files under extensions that have an `index.ts`. It recognizes:

- static imports, including type-only imports
- re-exports
- dynamic imports with a literal path
- `require()` calls with a literal path
- registered service contracts listed in `REQUIRED_SERVICE_CONTRACTS`
- literal `name` entries in `CHILD_RUNTIME_EXTENSIONS`

It skips tests, fixtures, declarations, caches, dependencies, and directory symlinks. It does not infer computed import paths or other semantic dependencies. Add an explicit graph test for those cases.

## Shared service contracts

A consumer can depend on a provider through a registry in `_shared` without importing the provider. When adding a required registry accessor, add a rule to `REQUIRED_SERVICE_CONTRACTS` in `dependency-audit.ts`. Pin the shared module export and provider registration in `catalog-graph.test.ts`. The audit currently recognizes named value imports of the required accessor and calls through a namespace import. Optional accessors do not create hard dependencies.

This mapping is deliberate maintenance work. A new shared registry does not become auditable until its provider contract has a rule and a test.

## Conditional and policy dependencies

`CUSTOM_TOOL_EXTENSIONS` maps child tools that only some subagents request. Web search and fetch therefore remain conditional researcher capabilities, not unconditional `tools-subagents` requirements.

Some requirements express policy rather than source availability. Permission requirements and workflow conflicts are examples. Source scanning cannot infer them, so `catalog-graph.test.ts` asserts them separately. Do not remove a requirement merely because the scanner finds no import.
