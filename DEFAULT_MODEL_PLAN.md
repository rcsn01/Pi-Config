# Default Model and Session Model Separation Plan

## Objective

Keep Pi's global default model separate from each session's active model while using `ui-model-selector` for fresh-session selection.

## Required Behavior

1. Pi stores a global default as `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json`.
2. Changing models through Pi while a session is open must:
   - update that session's active model;
   - append the model change to that session's JSONL history; and
   - update the global default for sessions created afterward.
3. Changing the global default must not change any other session that is already open.
4. A newly created session must start from the latest global default.
5. Resuming an existing session must restore that session's own model rather than replacing it with the current global default.
6. An explicit `--model` startup argument remains an invocation-specific override and bypasses automatic startup selection.

## Implementation Plan

### 1. Preserve Pi's native persistence path

- Route every `ui-model-selector` selection through `pi.setModel(model)`.
- Do not create a second extension-owned default-model file.
- Rely on Pi core to perform both required writes:
  - `SettingsManager.setDefaultModelAndProvider()` for the global default;
  - `SessionManager.appendModelChange()` for the current session.

### 2. Use `ui-model-selector` for fresh sessions

- Open the custom selector automatically for:
  - a fresh interactive startup with no restored conversation history;
  - `/new`.
- Preselect the session's currently active model, which Pi initializes from the global default.
- After the user chooses a model, thinking level, and optional context profile, apply the result with `pi.setModel()`.
- If the user cancels, leave Pi's already initialized global-default model active.

### 3. Keep existing sessions isolated

- Do not broadcast `model_select` events to other Pi processes or sessions.
- Do not watch `settings.json` and mutate an already-running session when the file changes.
- Skip automatic selection for `resume`, `reload`, and `fork` lifecycle events.
- Let resumed sessions restore the latest `model_change` from their own active session branch.

### 4. Respect startup overrides and non-interactive modes

- Detect both supported explicit model forms:
  - `--model provider/model`
  - `--model=provider/model`
- Skip the automatic selector when either form is present.
- Do not open TUI selection UI in print, JSON, or RPC modes.

### 5. Verify concurrent-session behavior

Test this sequence manually or with an integration harness:

1. Set the global default to Model A.
2. Open Session A and Session B; confirm both initially use Model A.
3. Change Session A to Model B through `ui-model-selector`.
4. Confirm Session A now uses Model B.
5. Confirm `settings.json` now contains Model B as the global default.
6. Confirm Session B remains on Model A while it stays open.
7. Create Session C; confirm it initializes with Model B.
8. Resume Session B; confirm it restores Model A from its session history.
9. Start Pi with `--model Model C`; confirm the automatic selector is skipped and the persisted global default remains Model B.

## Automated Test Coverage

- Fresh `startup` opens the selector.
- `/new` opens the selector.
- Startup with conversation history does not open it.
- `resume`, `reload`, and `fork` do not open it.
- `--model value` and `--model=value` bypass it.
- `--models` is not mistaken for `--model`.
- TypeScript type checking passes.
- The focused model-selector feature tests pass.

## Files

- `.pi/extensions/ui-model-selector/index.ts`
  - lifecycle wiring and selection application.
- `.pi/extensions/ui-model-selector/model-config.ts`
  - startup-trigger and CLI-override helpers.
- `.pi/extensions/ui-model-selector/model-config.test.ts`
  - trigger and bypass tests.

## Acceptance Criteria

- A model selected mid-session becomes the default for future sessions.
- Existing open sessions never change merely because the global default changed elsewhere.
- Resumed sessions retain their own model history.
- Fresh TUI sessions use the custom selector and persist its result through Pi core.
- No duplicate or competing default-model persistence mechanism exists in the extension.
