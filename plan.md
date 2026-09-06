# Plan: deepen Subagent assignment resolution with target-aware current meaning

**Candidate:** 1 from the architecture review, "Current meaning" accessor for
Subagent assignment resolution

**Status:** design finalised. All grilling decisions use the recommended answer.
This document is an implementation plan, not the implementation.

**Baseline:** `c3fdd4e` (`Add Plan guarded effect seam to the Plan session
currency`)

**Scope:**

- `.pi/extensions/tools-subagents/config.ts`
- `.pi/extensions/tools-subagents/model-commands.ts`
- `.pi/extensions/tools-subagents/test-harness.ts`
- `.pi/extensions/tools-subagents/config.test.ts`
- `.pi/extensions/tools-subagents/model-commands.test.ts`

The working tree already contains an unrelated modification to
`.pi/profiles/default.json`. Keep it untouched. The deleted `plan.md` is being
replaced by this plan at the user's request.

---

## 1. Goal

Make the Subagent assignment resolution module authoritative for both effective
assignment values and the target-specific choices shown by `/subagents`.

`config.ts` already owns the hard part of effective resolution:

- model precedence;
- thinking precedence;
- context-window metadata precedence;
- `main` resolution against the current Main model;
- legacy `default` and `provider/model:thinking` handling;
- Settings validation and assignment edits;
- persistence and legacy migration.

`model-commands.ts` already uses `resolveAssignment()` for status output in
`statusLines()`, `modelStatusLines()`, and `selectSubagentTarget()`. The
remaining shallow part is in the interactive picker. It reads the raw
`agentModels`, `defaultModel`, and `agentThinkingLevels` maps and splits model
suffixes to reconstruct:

- whether an individual target is set or inherits;
- whether the global target is unset or follows `main`;
- which direct model setting is current;
- which direct thinking setting is current;
- whether a legacy model suffix should be shown as the current thinking choice;
- how the current state compares with a pending model choice.

That is assignment meaning, not TUI formatting. It belongs behind the existing
assignment seam.

### Deletion test

Deleting the new accessor would put `Object.hasOwn(...)` checks, raw map reads,
model suffix parsing, and target-specific fallback decisions back into the
picker. Complexity would reappear at every command path. The accessor earns its
place because it concentrates that complexity in the existing deep module.

### Result

After this change:

- the command adapter asks one interface for a target's current choices and
effective assignment;
- current and pending picker states use the same implementation;
- the adapter keeps only target conversion, catalogue lookup, rendering, and
notifications;
- launch preparation keeps its existing narrow `resolveLaunch()` interface;
- Settings shape, migration, command text, and child launch values do not
change.

This is an in-process deepening. No external adapter or new file is needed.
The production Settings-backed store and the existing in-memory test store are
the two adapters that make the store seam real.

---

## 2. Grilling decision tree, resolved with recommended answers

These are the design questions that would have been asked during the grilling
loop. The recommended branch is final for each one.

### Q1. What is in scope?

**Recommended answer:** Only the missing semantic read projection for stored
Subagent assignments. Do not change command parsing, model catalogue lookup,
Settings persistence, child process launching, context-window policy, or Plan
Mode.

The existing `resolveSubagentAssignment()` and `resolveLaunch()` behavior is
already the correct effective-assignment seam. This change fills the picker
state gap around it.

### Q2. Where does the seam live?

**Recommended answer:** Keep the seam in
`.pi/extensions/tools-subagents/config.ts`, beside the existing assignment
parser, edit reducer, and resolver. Add one method to
`SubagentConfigStore`.

Do not create `assignment-selection.ts`. Splitting tightly coupled parsing,
selection, and effective resolution across files would reduce locality. The
new implementation belongs inside the module that already owns assignment
meaning.

### Q3. What interface shape gives the most depth?

**Recommended answer:** Add one target-aware
`resolveAssignmentSelection(options)` method. It returns the direct target
choices, the legacy model suffix when present, and the effective
`ResolvedSubagentAssignment` in one result.

Do not add four accessors such as `currentModel()`, `currentThinking()`,
`currentContext()`, and `currentSource()`. That would preserve a wide interface
and make callers assemble the meaning again.

### Q4. How are `all` and an individual agent represented?

**Recommended answer:** Use discriminated options. The `all` target has no
`AgentConfig`; an individual target requires the matching `AgentConfig` because
frontmatter participates in its effective fallback.

Do not fabricate an agent with empty frontmatter for the `all` target. The
`all` target resolves only the global setting and `main` fallback.

### Q5. How do hypothetical picker choices work?

**Recommended answer:** Accept the same immutable `snapshot` and one semantic
`SubagentAssignmentEdit` pattern already used by `resolveAssignment()`. Apply
the edit in memory, then resolve the result. Make separate calls for current
and pending state.

Do not cache a selection result across screens. Do not mutate the snapshot. Do
not put both current and pending state into one long-lived object.

### Q6. How should legacy `:thinking` suffixes work?

**Recommended answer:** The accessor returns the suffix on the target's direct
model setting as `modelSuffixThinkingLevel`. The effective assignment continues
to apply the existing precedence rules.

A fallback suffix from global configuration or agent frontmatter is effective
for an individual agent, but it is not that agent's direct model choice. The
accessor must preserve this distinction so the picker still shows `inherit` in
that case.

### Q7. What stays in the command adapter?

**Recommended answer:** Formatting, notifications, target conversion, model
catalogue lookup, and the comparison between the current and pending model
choice. The adapter may map semantic choices to the strings required by
`pickSelectScreen()`.

The adapter must not read assignment maps to decide precedence or split a raw
configured model to discover effective thinking. That work crosses the
assignment interface.

### Q8. What compatibility guarantee is required?

**Recommended answer:** Preserve all observable behavior. Keep
`resolveAssignment()` and `resolveLaunch()` as existing interfaces. Do not
change the Settings schema, legacy migration, command usage text, notification
text, menu labels, sort order, cancellation behavior, or child launch fields.

### Q9. What is the test strategy?

**Recommended answer:** Test the pure selection resolver through its interface,
then test the command adapter through rendered output and persisted outcomes.
Keep existing effective-resolution and persistence tests. Do not expose private
picker helpers for tests.

The interface is the test surface. The command tests should not reconstruct the
same precedence rules in their setup or assertions.

### Q10. What documentation changes are needed?

**Recommended answer:** No README behavior change. The existing `CONTEXT.md`
term, **Subagent assignment resolution module**, already names the owner of
assignment parsing, precedence, persistence, preview, and launch resolution.
If implementation wording needs sharpening, amend that existing entry rather
than adding a second domain term or module.

---

## 3. Current architecture and target architecture

### Before

```text
                         effective assignment
launch-preparation ------------------------------> resolveLaunch()
                                                        |
                                                        v
                                             config.ts resolver

/subagents status -------------------------------> resolveAssignment()
/subagents target ------------------------------> resolveAssignment()

interactive model picker ---> raw agentModels/defaultModel + split suffixes
interactive thinking picker -> raw thinking maps + split suffixes
                              + hand-written target precedence
```

The lower two paths cross the module seam only for some previews. They still
know how to interpret direct versus inherited choices. That is the locality
problem.

### After

```text
launch-preparation ------------------------------> resolveLaunch()
                                                        |
                                                        v
                                             parsed assignment core
                                                        ^
                                                        |
/subagents status -------------------------------> resolveAssignmentSelection()
/subagents target -------------------------------> resolveAssignmentSelection()
model picker current/pending -------------------> resolveAssignmentSelection()
thinking picker current/pending ----------------> resolveAssignmentSelection()
```

`resolveAssignmentSelection()` returns semantic choices plus an effective
assignment. The command adapter formats those values. `resolveLaunch()` still
returns only launch data, so display metadata cannot leak into child execution.

---

## 4. Chosen interface

Add the following types near the existing assignment types in
`.pi/extensions/tools-subagents/config.ts`.

### 4.1 Direct model choice

```ts
export type SubagentAssignmentModelSelection =
	| { readonly kind: "default" }
	| { readonly kind: "inherit" }
	| { readonly kind: "set"; readonly setting: string };
```

Meaning:

| Choice | Valid target | Meaning |
| --- | --- | --- |
| `{ kind: "default" }` | `all` | No `defaultModel` is stored. The effective global model falls back to `main`. |
| `{ kind: "inherit" }` | individual agent | No `agentModels[agentName]` is stored. The agent follows global, frontmatter, or `main` precedence. |
| `{ kind: "set", setting }` | both | The target has a direct model setting. `setting` remains normalized and may retain a legacy `:thinking` suffix. |

`default` is a read result, not a new persisted model value. A global edit
still uses the existing `SubagentModelEdit` type and stores `main` when that is
the selected value.

### 4.2 Target-aware options

Use a discriminated target shape so callers cannot accidentally omit an agent
for an individual selection.

```ts
type AssignmentSelectionTarget =
	| {
			readonly target: { readonly kind: "all" };
			readonly agent?: never;
	  }
	| {
			readonly target: { readonly kind: "agent"; readonly name: string };
			readonly agent: AgentConfig;
	  };

export type ResolveStoredAssignmentSelectionOptions = AssignmentSelectionTarget & {
	snapshot?: ExtensionConfig;
	edit?: SubagentAssignmentEdit;
};

export type ResolveAssignmentSelectionOptions = AssignmentSelectionTarget & {
	config?: unknown;
	mainModel: string | { provider: unknown; id: unknown } | undefined;
};
```

The implementation validates at the type level, matching the existing
`resolveAssignment()` seam rather than adding new runtime checks:

- an empty or invalid target uses the existing assignment-target error
  behavior where applicable, inherited from `applySubagentAssignmentEdit()`;
- an `all` target must not use agent frontmatter.

Do not add a runtime check that `agent.name` equals `target.name`, or that a
supplied `edit.target` matches `target`. `resolveAssignment()` has never
enforced this between its own `agent` and `edit` arguments, and every real
caller builds both from the same target string in one place in
`model-commands.ts`. A mismatch could only happen through a bypassed type
system, which this module does not otherwise guard against.

### 4.3 Result

```ts
export interface ResolvedSubagentAssignmentSelection {
	/** Direct target choice used by the model picker. */
	readonly model: SubagentAssignmentModelSelection;
	/** Legacy :thinking suffix on the direct target model choice, if present. */
	readonly modelSuffixThinkingLevel?: SubagentThinkingLevel;
	/** Direct target thinking choice, excluding any model suffix. */
	readonly thinking: SubagentThinkingEdit;
	/** Effective assignment after fallback and current Main-model resolution. */
	readonly assignment: ResolvedSubagentAssignment;
}
```

The `thinking` field reuses `SubagentThinkingEdit` because its three meanings
already match the stored target choices:

- `set` means `defaultThinkingLevel` for `all` or
  `agentThinkingLevels[name]` for an individual;
- `default` means the global target has no explicit thinking level;
- `inherit` means the individual target has no explicit thinking level.

The result intentionally separates `modelSuffixThinkingLevel` from
`thinking`. A suffix is part of a legacy model setting. It is not the same
thing as a separate `agentThinkingLevels` or `defaultThinkingLevel` value.

### 4.4 Store interface

Add one method to `SubagentConfigStore`:

```ts
resolveAssignmentSelection(
	options: ResolveStoredAssignmentSelectionOptions,
): ResolvedSubagentAssignmentSelection;
```

The existing methods remain:

```ts
resolveAssignment(
	agent: AgentConfig,
	options?: ResolveStoredAssignmentOptions,
): ResolvedSubagentAssignment;
resolveLaunch(
	agent: AgentConfig,
	explicitModel?: string,
	explicitThinkingLevel?: SubagentThinkingLevel,
): ResolvedLaunchConfiguration;
```

`resolveLaunch()` stays narrow. It must continue returning `.launch`, not the
new selection result.

### 4.5 Pure implementation path

Refactor the body of `resolveSubagentAssignment()` into a private parsed
implementation so the new selection resolver parses the configuration once.
The shape is:

```ts
function resolveParsedSubagentAssignment(
	options: ResolveLaunchOptions,
	config: ModelConfiguration,
): ResolvedSubagentAssignment {
	// Existing model, thinking, context, and main-model logic.
}

export function resolveSubagentAssignment(
	options: ResolveLaunchOptions,
): ResolvedSubagentAssignment {
	const config = parseModelConfiguration(options.config ?? {});
	return resolveParsedSubagentAssignment(options, config);
}

export function resolveSubagentAssignmentSelection(
	options: ResolveAssignmentSelectionOptions,
): ResolvedSubagentAssignmentSelection {
	const config = parseModelConfiguration(options.config ?? {});

	const assignment = resolveParsedSubagentAssignment(
		{
			agentName: options.target.kind === "agent" ? options.agent.name : "",
			config,
			frontmatterModel: options.target.kind === "agent" ? options.agent.model : undefined,
			mainModel: options.mainModel,
		},
		config,
	);

	// Derive direct target choices from the parsed config. Do not infer inherit
	// from the effective assignment because equal effective values can come from
	// different sources.
	return {
		model: /* target-specific direct/default/inherit choice */,
		...(/* direct model suffix, if any */),
		thinking: /* target-specific direct/default/inherit choice */,
		assignment,
	};
}
```

The actual implementation must keep the existing resolver's branch order and
error messages unchanged. The new function adds a semantic projection; it
does not introduce another precedence implementation.

For the stored adapter method, mirror the existing `resolveAssignment()`
pattern:

```ts
const resolveAssignmentSelection = (
	options: ResolveStoredAssignmentSelectionOptions,
): ResolvedSubagentAssignmentSelection => {
	let config: unknown = options.snapshot ?? readSettingsNamespace();
	if (options.edit) {
		config = applySubagentAssignmentEdit(config, options.edit);
	}
	return resolveSubagentAssignmentSelection({
		...options,
		config,
		mainModel: activeMainModel,
	});
};
```

Do not write during selection resolution. Do not cache `activeMainModel` beyond
the existing remembered value. `/model` updates must affect later selection and
launch calls exactly as they do today.

---

## 5. Exact selection semantics

The implementation and tests must pin these cases.

### 5.1 Model choice

For `target.kind === "all"`:

1. If `config.defaultModel` exists, return
   `{ kind: "set", setting: config.defaultModel }`.
2. Otherwise return `{ kind: "default" }`.
3. Parse the suffix only from `config.defaultModel`.
4. Resolve the effective assignment without agent frontmatter or an
   individual model override.

For `target.kind === "agent"`:

1. If `config.agentModels[target.name]` exists, return
   `{ kind: "set", setting: config.agentModels[target.name] }`.
2. Otherwise return `{ kind: "inherit" }`.
3. Parse a suffix only from that direct agent model setting.
4. Resolve the effective assignment with the matching `AgentConfig`, so global,
   frontmatter, and `main` fallback remain available.

Examples:

| Settings | Target | `model` | `modelSuffixThinkingLevel` |
| --- | --- | --- | --- |
| no `defaultModel` | `all` | `default` | absent |
| `defaultModel: "main"` | `all` | `set("main")` | absent |
| `defaultModel: "openai/gpt:high"` | `all` | `set("openai/gpt:high")` | `high` |
| no `agentModels.worker` | `worker` | `inherit` | absent, even if global or frontmatter has a suffix |
| `agentModels.worker: "openai/gpt:xhigh"` | `worker` | `set("openai/gpt:xhigh")` | `xhigh` |

### 5.2 Thinking choice

For `target.kind === "all"`:

- `defaultThinkingLevel` present -> `{ kind: "set", level }`;
- absent or legacy `default` -> `{ kind: "default" }`.

For `target.kind === "agent"`:

- `agentThinkingLevels[target.name]` present -> `{ kind: "set", level }`;
- absent or legacy `default` -> `{ kind: "inherit" }`.

The separate thinking choice does not erase a model suffix. The effective
`assignment.launch.thinkingLevel` continues to follow the current resolver.
For example, a global `openai/gpt:high` suffix beats global `minimal` thinking,
while an individual `agentThinkingLevels.worker: low` beats that suffix.

### 5.3 Effective assignment

The `assignment` field must be exactly the existing
`resolveSubagentAssignment()` result for the same stored configuration:

Model selection:

1. `agentModels[agentName]`;
2. `defaultModel`;
3. agent Markdown frontmatter `model`;
4. `main`.

Thinking selection for a stored assignment:

1. `agentThinkingLevels[agentName]`;
2. thinking suffix on the selected model;
3. `defaultThinkingLevel`;
4. Pi default, represented by `undefined`.

Context metadata selection:

1. `agentContextWindows[agentName]`;
2. `defaultContextWindow`;
3. `undefined`.

The explicit invocation branches remain in
`resolveSubagentAssignment()` for launch preparation. The stored selection
projection does not invent invocation overrides.

---

## 6. File-by-file implementation

### 6.1 `.pi/extensions/tools-subagents/config.ts`

1. Add `SubagentAssignmentModelSelection` beside
   `SubagentModelEdit` and `SubagentThinkingEdit`.
2. Add the discriminated selection option types.
3. Add `ResolvedSubagentAssignmentSelection`.
4. Add `resolveAssignmentSelection()` to `SubagentConfigStore`.
5. Extract the current resolver body into
   `resolveParsedSubagentAssignment(options, parsedConfig)` without changing
   branch order, normalization, or errors.
6. Keep `resolveSubagentAssignment()` exported and make it parse once before
   calling the parsed implementation.
7. Add `resolveSubagentAssignmentSelection()` as the one pure semantic
   selection projection.
8. Derive direct model and thinking choices from `ModelConfiguration`, not from
   the effective result. Effective values cannot tell `inherit` from a direct
   setting when both resolve to the same model or level.
9. Use `splitModelThinkingSetting()` exactly once for the direct target model
   setting when deriving `modelSuffixThinkingLevel`.
10. For `all`, pass no frontmatter and no fabricated `AgentConfig` into the
    effective resolver.
11. For an individual, require the matching `AgentConfig` and pass its
    `name` and `model` into the effective resolver.
12. Add the production store closure beside the existing `resolveAssignment`
    closure. It must read the same Settings namespace, honor the same legacy
    fallback, apply edits only to an in-memory copy, and use `activeMainModel`.
13. Keep `resolveAssignment()` and `resolveLaunch()` behavior intact.
14. Keep `ResolvedLaunchConfiguration` unchanged. `contextWindow` remains
    descriptive metadata and is not a child context-window override.
15. Keep persistence, migration, parser diagnostics, and unknown namespace
    preservation unchanged.

Implementation notes:

- Do not move the assignment edit reducer into the command adapter.
- Do not expose raw `ModelConfiguration` maps through the new interface.
- Do not add a source enum unless a test proves the selected choice fields are
  insufficient. The recommended design uses direct choice plus suffix and
  effective assignment, which covers current callers without extra metadata.
- Do not add a new file. The module already has depth and the new behavior
  belongs at its existing seam.

### 6.2 `.pi/extensions/tools-subagents/model-commands.ts`

Add one local wiring helper with no assignment logic. It should:

- convert the command's string target to `SubagentAssignmentTarget`;
- pass the matching `AgentConfig` for an individual;
- pass the loaded `ExtensionConfig` as `snapshot`;
- optionally pass a matching `SubagentAssignmentEdit`;
- call `configStore.resolveAssignmentSelection()`.

The helper may narrow the TypeScript union. It must not inspect
`agentModels`, `defaultModel`, `agentThinkingLevels`, or suffixes.

#### `statusLines()`

Replace `configStore.resolveAssignment(agent, { snapshot: config })` with the
selection result's `.assignment`.

Keep the existing formatting:

- `modelDisplay(assignment.modelSetting, assignment.launch.model)`;
- `thinkingDisplay(assignment.launch.thinkingLevel)`;
- `contextDisplay(assignment.launch.contextWindow)`;
- missing-tool checks and notifications.

#### `modelStatusLines()`

Use `.assignment` for each effective-assignment row.

Keep the raw override lists based on `configStore.load()`. Those lists are an
intentional persisted-Settings display, not effective precedence logic.

#### `selectSubagentTarget()`

Resolve the `all` target through the new accessor so the adapter no longer
splits `config.defaultModel` to derive the global row.

Map the result as follows:

- `model.kind === "default"` keeps the existing
  `"(unset; per-agent fallback)"` label;
- otherwise use `modelDisplay(assignment.modelSetting,
  assignment.launch.model)`;
- use `modelSuffixThinkingLevel` when present, otherwise use the level from a
  `thinking.kind === "set"` choice, otherwise show `Pi default`;
- keep the existing `clears individual overrides` text.

Resolve every individual target through the accessor and format its
`.assignment` exactly as before.

#### `selectSubagentModel()`

1. Resolve the current target once.
2. Derive the picker `currentValue` from semantic result fields:
   - `model.kind === "inherit"` -> `"inherit"`;
   - `model.kind === "default"` -> `"main"`;
   - `model.kind === "set"` -> `assignment.modelSetting`.
3. Keep the raw `model.setting` only for the existing
   `configured as <raw-setting>` presentation when a legacy suffix is present.
4. Resolve the individual inherit preview by passing the existing semantic
   `{ model: { kind: "inherit" } }` edit and formatting the returned
   `.assignment`.
5. Keep the Main-model item and all model catalogue filtering unchanged.
6. Remove the `Object.hasOwn(config.agentModels, target)` branch and the
   `splitModelThinkingSetting(currentValue)` call from this picker.
7. Keep `pickSelectScreen()` options and current-marker behavior unchanged.

The current model base and the raw configured setting have different jobs. Use
`assignment.modelSetting` for the marker value and `model.setting` for the
legacy configured text. Do not collapse them into one field.

#### `findCatalogueModel()`

Change the caller to pass the canonical base value from
`pendingSelection.assignment.modelSetting`. The helper may still resolve
`main` through `configStore.resolveMainModel()` and use the model registry
fallback. It should no longer split a raw configured setting or decide
assignment precedence.

`catalogueModelReference()` may continue using
`splitModelThinkingSetting()` for direct user input to
`validateAvailableModel()`. That is input normalization, not current assignment
resolution, and remains in the adapter by design.

#### `selectSubagentThinking()`

Use two selection calls:

1. `currentSelection` from the unedited snapshot;
2. `pendingSelection` from the same snapshot plus the model edit chosen in the
   previous screen.

Resolve `pendingModelSetting` from
`pendingSelection.assignment.modelSetting`, then use it for catalogue lookup
and supported thinking levels.

Compute the current picker value from semantic fields without reading raw
maps:

- For `all`, use the direct model suffix when it exists and the current and
  pending base models match. Otherwise use a direct global thinking level or
  `"default"`.
- For an individual, use a direct thinking level first. If there is no direct
  level, use the direct model suffix only when its base model matches the
  pending model. Otherwise use `"inherit"`.
- When a suffix supplies the individual value, use
  `currentSelection.assignment.launch.thinkingLevel` for the exact existing
  effective value.

Build the individual `inherit` description with the pending model edit plus a
thinking inherit edit, then format the returned effective assignment. Do not
read `agentThinkingLevels` or `agentModels` directly.

Keep these behaviors:

- a model change is a pending edit, not an invocation override;
- a per-agent thinking setting remains explicit even if the pending model
  changes;
- a legacy suffix is a current thinking choice only when its base model is the
  pending model;
- `all` offers Pi default, while an individual offers inherit;
- the screen and cancellation flow remain unchanged.

#### Functions that remain adapter-owned

These stay in `model-commands.ts`:

- `assignmentTarget()` and target-string validation;
- `modelEdit()`, `thinkingEdit()`, and `combinedEdit()` because they lower
  command input into the existing edit interface;
- `requireKnownTarget()` and all `ctx.ui.notify()` calls;
- model catalogue refresh and authentication checks;
- `contextDisplay()`, `modelDisplay()`, and `thinkingDisplay()`;
- raw persisted override lists in `modelStatusLines()`;
- direct command parsing and usage text.

The command adapter is still a Pi adapter. It should not become a second
assignment implementation.

### 6.3 `.pi/extensions/tools-subagents/test-harness.ts`

1. Import `resolveSubagentAssignmentSelection` and its option/result types as
   needed.
2. Add `resolveAssignmentSelection()` to `memoryConfigStore()`.
3. Mirror the production store exactly:
   - use `options.snapshot ?? store.document`;
   - apply `options.edit` with `applySubagentAssignmentEdit()` to a cloned
     document;
   - call the pure selection resolver with `activeMainModel`;
   - never mutate the snapshot;
   - preserve the existing `updates` and `edits` recording behavior for commits.
4. Do not write a second selection or precedence implementation in the test
   adapter.

### 6.4 `.pi/extensions/tools-subagents/config.test.ts`

Keep the existing `resolveSubagentAssignment()` table. It remains the test
surface for effective launch precedence and explicit invocation overrides.
Add a new `describe("subagent assignment selection", ...)` for the new pure
resolver.

Required cases:

1. `all` with no global model returns `model.kind === "default"` and an
   effective `main` assignment.
2. `all` with explicit `defaultModel: "main"` returns `model.kind === "set"`
   with `setting: "main"`.
3. `all` with `defaultModel: "openai/gpt:high"` returns the raw normalized
   setting and `modelSuffixThinkingLevel: "high"`.
4. `all` with a model suffix and global thinking proves the suffix still wins
   in `assignment.launch.thinkingLevel`.
5. An individual without an `agentModels` entry returns `model.kind ===
   "inherit"` even when global configuration supplies a model.
6. An individual without an `agentModels` entry returns no direct suffix even
   when global configuration or frontmatter contains a suffix.
7. An individual with `agentModels.worker: "openai/gpt:xhigh"` returns a set
   model and `modelSuffixThinkingLevel: "xhigh"`.
8. An individual direct thinking setting beats its direct model suffix in the
   effective assignment.
9. An individual without direct thinking returns `thinking.kind ===
   "inherit"`, while its effective assignment can still inherit a global
   thinking level.
10. An `all` target without direct thinking returns `thinking.kind ===
    "default"`.
11. An `all` target with direct thinking returns `thinking.kind === "set"`.
12. A concrete direct model does not require a current Main model; a `main`
    fallback still produces the existing missing-Main-model error.
13. A malformed model, thinking, or context setting preserves the existing
    parser error.

Use table-driven cases for the precedence combinations. Assert the complete
semantic result where it is stable:

```ts
expect(resolveSubagentAssignmentSelection({
	target: { kind: "agent", name: "worker" },
	agent: agent(),
	config: {
		defaultModel: "openai/global:high",
		agentThinkingLevels: { worker: "low" },
	},
	mainModel,
})).toEqual({
	model: { kind: "inherit" },
	thinking: { kind: "set", level: "low" },
	assignment: {
		modelSetting: "openai/global",
		launch: {
			model: "openai/global",
			thinkingLevel: "low",
			contextWindow: undefined,
		},
	},
});
```

For absent optional suffixes, assert that the property is absent or undefined
consistently with the chosen implementation. Do not assert private helper
calls.

Extend store tests with:

- production `resolveAssignmentSelection()` delegates to the pure resolver;
- a snapshot plus edit produces the same selection that a later committed edit
  produces;
- selection preview leaves the Settings file unchanged;
- changing the remembered Main model changes later `main` selection results;
- `resolveLaunch()` still returns only launch fields and does not expose
  `model` selection metadata.

Keep all existing edit, migration, queue, Settings preservation, parser, and
child-argument tests. They cover separate interfaces and should not be deleted.

### 6.5 `.pi/extensions/tools-subagents/model-commands.test.ts`

Keep the tests that cover notifications, direct commands, catalogue failures,
unknown agents, cancellation, and persisted edits. Add focused black-box cases
for the paths moved to the new accessor.

1. **Effective status remains unchanged.** Use a global model suffix, an
   individual thinking override, and an individual context setting. Assert the
   same effective status line and the absence of the raw suffix in the separate
   thinking text.
2. **Individual direct suffix remains visible in the model picker.** Configure
   `agentModels.worker` with a `:high` suffix, open the worker model picker,
   and assert that the base model is marked current while the description still
   says `configured as <raw-setting>`.
3. **Inherited fallback remains visible.** Use a table or the existing scripted
   picker flow for global, frontmatter, and Main fallback. Assert the inherit
   description and no Settings writes.
4. **Global target preserves unset versus explicit Main.** Open the target
   picker once with no `defaultModel` and once with `defaultModel: "main"`.
   Assert the existing global-row text, including
   `"(unset; per-agent fallback)"` for the unset case.
5. **Pending model drives thinking preview.** Choose a model for an individual,
   then inspect the thinking screen. Assert that the displayed model and
   inherited thinking description come from the pending model edit, not the
   current stored model.
6. **Suffix current-marker rules remain unchanged.** Cover:
   - same base model plus direct suffix selects that suffix level;
   - a changed pending base model falls back to inherit/default;
   - a direct agent thinking override wins over the suffix.
7. **No preview writes.** Cancel from target, model, and thinking screens and
   assert zero `updates` and zero `edits`.

Drive the existing `screenCustom()` helper and assert rendered screen text or
current markers. Do not export private selector functions. Do not assert that a
particular config map was read; assert what the command presented and whether
it wrote Settings.

### 6.6 `.pi/extensions/tools-subagents/launch-preparation.ts`

No production change is expected.

Keep its `Pick<SubagentConfigStore, "resolveLaunch">` dependency narrow. The
new selection method must not force launch preparation to know about display
choices.

Run its current tests to confirm:

- one registry snapshot;
- whole-request validation before resolution;
- one launch resolution per request;
- no partial work after a later validation failure;
- only normalized launch data reaches child execution.

### 6.7 `.pi/extensions/tools-subagents/subagent-execution.ts`, `index.ts`, and `README.md`

No production change is expected.

`subagent-execution.ts` continues to receive `ResolvedLaunchConfiguration`.
`index.ts` keeps its Pi wiring and dependency construction. `README.md` keeps
its current precedence and suffix wording because this refactor changes no
behavior.

After implementation, compare the README precedence tables with the tests. If
the wording has an error, fix the wording in a separate deliberate edit. Do not
add internal implementation detail to user documentation.

### 6.8 `CONTEXT.md`

The existing **Subagent assignment resolution module** entry already names the
correct domain concept and seam. No new domain term or separate module is
needed.

If the implementation adds a sentence, amend only that existing entry to say
that the module also owns target-aware current model/thinking choices and
legacy direct-model suffix interpretation for the command adapter. Do not add a
second glossary entry for a UI-specific name.

---

## 7. Implementation order

Use one coherent refactor. Keep the working tree's unrelated profile change
out of the diff.

### Step 0: Baseline

From `.pi/`, run the focused current suite and typecheck before editing code:

```bash
pnpm exec vitest run \
	extensions/tools-subagents/config.test.ts \
	extensions/tools-subagents/model-commands.test.ts \
	extensions/tools-subagents/launch-preparation.test.ts
pnpm typecheck
```

If the baseline fails, record the failure before attributing it to this plan.

### Step 1: Add the semantic result and characterization tests

In `config.test.ts`:

- add imports for the new pure resolver and types;
- add the target-aware selection cases;
- add target, suffix, direct-thinking, and fallback assertions;
- add preview and Main-model freshness cases at the store interface.

The tests should initially fail because the new method and result do not exist.
Do not change the existing effective-resolution cases while adding the new
surface.

### Step 2: Implement the pure resolver in `config.ts`

- extract the parsed effective resolver without changing behavior;
- add the discriminated target types and result type;
- implement direct model choice derivation;
- implement direct thinking choice derivation;
- parse only the direct target model suffix;
- construct the effective assignment through the shared parsed resolver;
- make the new pure tests pass.

At the end of this step, all assignment semantics still live in `config.ts`.

### Step 3: Add the production and memory store methods

- add `resolveAssignmentSelection()` to `SubagentConfigStore`;
- implement the Settings-backed method beside `resolveAssignment()`;
- implement the memory adapter method through the same pure resolver;
- keep edit previews immutable;
- keep `resolveLaunch()` unchanged except for any type-only adjustments.

Run `config.test.ts` after this step.

### Step 4: Migrate command status and target descriptions

- add the thin local store-call helper in `model-commands.ts`;
- move `statusLines()` and effective rows in `modelStatusLines()` to
  `.assignment`;
- move individual and global target descriptions to the new result;
- preserve raw persisted override lists and exact text.

Run the model command tests before changing picker internals.

### Step 5: Migrate model picker state

- replace raw current model map reads with `currentSelection.model`;
- preserve base model marker and raw suffix display using separate result
  fields;
- use selection-based hypothetical edits for inherit preview;
- pass canonical pending assignment model to catalogue lookup;
- remove only the now-obsolete current-state map and suffix branches.

Run the model command tests after this step.

### Step 6: Migrate thinking picker state

- resolve current and pending selections separately;
- derive pending model and supported thinking levels from the pending effective
  assignment;
- derive current marker from direct thinking choice, direct suffix, and the
  current-versus-pending base comparison;
- use a pending inherit edit for the inherited description;
- preserve all current `all` versus individual behavior.

Add or finish the suffix-marker tests, then run the whole subagent suite.

### Step 7: Remove only obsolete adapter logic

After tests pass, use `rg` to confirm that `model-commands.ts` no longer has
assignment precedence branches in the picker. Remove unused imports and local
variables only after the migration is complete.

Do not remove `splitModelThinkingSetting()` from `config.ts`. It remains part of
the assignment implementation and direct input normalization.

### Step 8: Documentation and final review

- verify that `CONTEXT.md` still accurately describes the module;
- do not change README wording unless a real documentation error appears;
- review the diff for Settings writes, command text, and launch-shape changes;
- confirm the unrelated `.pi/profiles/default.json` modification remains
  untouched.

---

## 8. Verification commands

Run from `.pi/`:

```bash
pnpm exec vitest run extensions/tools-subagents/config.test.ts
pnpm exec vitest run extensions/tools-subagents/model-commands.test.ts
pnpm exec vitest run extensions/tools-subagents/launch-preparation.test.ts
pnpm test:subagents
pnpm typecheck
```

Run the broader shared tests because the store interface is used by shared
adapters and type definitions:

```bash
pnpm test:core
```

Check for stale duplicated resolution logic:

```bash
rg -n \
  "resolveAssignment\(|currentRawModel|hasOverride|Object\\.hasOwn\\(config\\.(agentModels|agentThinkingLevels)|splitModelThinkingSetting\\(current" \
  extensions/tools-subagents/model-commands.ts
```

Expected results:

- no old `resolveAssignment()` calls remain in `model-commands.ts` for the
  migrated status or picker paths;
- no `currentRawModel` or `hasOverride` helper remains;
- no picker-specific `Object.hasOwn(config.agentModels, ...)` or
  `Object.hasOwn(config.agentThinkingLevels, ...)` remains;
- `splitModelThinkingSetting()` may remain for direct input normalization and
  must not be treated as a failure by itself.

Check the final diff:

```bash
git diff --check
git status --short
git diff -- .pi/extensions/tools-subagents/config.ts \
  .pi/extensions/tools-subagents/model-commands.ts \
  .pi/extensions/tools-subagents/test-harness.ts \
  .pi/extensions/tools-subagents/config.test.ts \
  .pi/extensions/tools-subagents/model-commands.test.ts \
  CONTEXT.md
```

The final diff must not modify `.pi/profiles/default.json` as part of this
work. `plan.md` is the requested plan artifact.

---

## 9. Acceptance criteria

### Assignment module

- `resolveSubagentAssignmentSelection()` is the only implementation of
  target-specific direct model and thinking choice meaning.
- `resolveParsedSubagentAssignment()` is the shared implementation of effective
  model, thinking, and context precedence.
- The new result contains direct model choice, direct suffix metadata, direct
  thinking choice, and the existing effective assignment.
- `all` never receives fabricated frontmatter.
- Individual selections require the matching `AgentConfig`.
- Hypothetical edits are applied to a clone and never persisted.
- Current Main-model changes are observed on later calls. No stale cache exists.
- Existing parser errors and missing-Main-model errors remain unchanged.

### Command adapter

- `statusLines()`, effective rows in `modelStatusLines()`, and target
  descriptions use the new selection interface.
- Model and thinking pickers resolve current and pending state through the same
  interface.
- The adapter contains no assignment precedence implementation.
- The adapter still owns formatting, notifications, model catalogue lookup,
  direct command parsing, and Pi interaction.
- Existing current markers, suffix text, menu labels, and cancellation paths are
  unchanged.

### Launch and persistence

- `resolveLaunch()` keeps its existing narrow interface and result shape.
- Launch preparation and child execution receive no selection metadata.
- No Settings schema, migration, queue, or atomic-write behavior changes.
- Unknown Settings and subagent namespace keys remain preserved.

### Tests and documentation

- New selection tests cover all-versus-agent, direct-versus-inherited,
  suffix-versus-explicit-thinking, pending-model, and Main-model cases.
- Command tests assert observable rendered output and write behavior rather than
  private helper calls.
- Existing subagent tests, shared tests, and typecheck pass.
- `CONTEXT.md` remains accurate and no UI-specific glossary term is added.

### Architecture outcome

The assignment module becomes deeper. Callers learn one target-aware
interface, while the implementation hides direct choice interpretation,
legacy suffix handling, effective fallback, and Main-model resolution.

The command adapter gains leverage from one result across status and both picker
screens. Maintainers gain locality because a change to assignment meaning lands
in `config.ts` and its interface tests instead of in several command branches.

---

## 10. Risks and controls

### Legacy suffix precedence

A model suffix is not always a direct thinking choice. A fallback suffix can
be effective without being selected directly by the individual target.

**Control:** return `modelSuffixThinkingLevel` only for the target's direct
model setting. Keep effective thinking in `assignment.launch.thinkingLevel`.
Test global, frontmatter, per-agent, and per-agent-thinking-overrides cases.

### Current versus pending model

The thinking picker compares the stored current model with a prospective model
choice. Using the pending result as the current result would make current
markers drift.

**Control:** make two accessor calls from the same snapshot. Use current result
for current markers and pending result for catalogue and inherited descriptions.

### Global target semantics

The global target has no frontmatter fallback. Passing a fabricated agent would
silently change global display and thinking behavior.

**Control:** discriminated options and a pure `all` path with no agent.

### `default` versus explicit `main`

Both can launch the current Main model but the target picker displays them
differently. Collapsing them would remove the existing unset diagnostic.

**Control:** return `model.kind === "default"` when no global setting exists and
`model.kind === "set"` for explicit `main`.

### Main-model freshness

Caching the new result could make `/model` changes invisible to later picker or
launch calls.

**Control:** resolve against the store's current `activeMainModel` on each
call. Keep the existing `rememberMainModel()` wiring unchanged.

### Display metadata leaking into launch

A caller could accidentally pass the new selection result to child execution.

**Control:** keep `assignment.launch` nested and make `resolveLaunch()` return
only that nested object. Preserve the existing `Pick<SubagentConfigStore,
"resolveLaunch">` in launch preparation.

### Over-testing implementation details

Tests that assert raw map reads or private selector helpers would preserve the
shallow design.

**Control:** test the pure resolver's semantic result and the command's
rendered output. Keep only the existing parser and persistence tests that cover
their own interfaces.

### Scope drift

The architecture review found other friction in Plan Mode, Analysis capture,
Guardian context, dashboards, Session holders, and fake-Pi fixtures. None of
those are part of this candidate.

**Control:** no changes outside the listed files except a deliberate wording
amendment to the existing `CONTEXT.md` entry if needed.

---

## 11. Rollback point

This change has no data migration and no persisted-state change.

If a picker behavior mismatch appears:

1. keep the new pure selection tests as characterization;
2. restore the command adapter's previous picker reads temporarily;
3. keep `resolveAssignment()` and `resolveLaunch()` unchanged;
4. isolate the mismatch to direct choice, suffix interpretation, or pending
   state before retrying the picker migration.

No Settings repair or user action is required for rollback.
