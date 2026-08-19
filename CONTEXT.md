# Domain Terms — Session Profiles

Canonical vocabulary for the session-profile feature (`.pi/extensions/_shared/active-profile.ts`
and its consumers). Use these terms consistently in code, comments, and future architecture work.

- **Session profile**: a named settings document (`.pi/profiles/<name>.json`) that holds
  extension-managed settings for a session (ui-model-selector, workflows-plan-mode,
  tools-subagents, tools-advisor). It is the source of truth for those settings while bound;
  `.pi/settings.json` holds only the active marker plus shared pi-core settings.

- **Active marker**: the `configProfiles.active` value in `.pi/settings.json`, written by
  config-profiles when the user switches profiles. It names the profile for *new* session
  boundaries; it never binds an existing session.

- **Remembered session entry**: the last custom session entry of type `configProfiles` on the
  session branch. It records which profile this session was started with and is authoritative
  on `reload`, so another session's `/profile` switch cannot rebind this one.

- **Profile binding**: the one-time resolution at `session_start` of the session's effective
  settings document from the active marker and remembered session entry. Marker wins on new
  session boundaries; the remembered entry wins on `reload`; validation failures fall back to
  the next source. `session_tree` navigation updates profile status but never rebinds stores.

- **Effective settings document**: the concrete path every consuming extension repoints its
  settings store at — a profile file when a profile is bound, else the plain
  `.pi/settings.json`. `SessionProfileResolver.resolve()` always returns one concrete path, so
  consumers never branch on "profile vs. no profile".

- **Settings-document module**: `.pi/extensions/_shared/settings-document.ts`, the shared owner
  of settings-document parsing, reads, atomic writes, and queued mutations, and the canonical
  home of `PROJECT_SETTINGS_PATH`. Namespace validation and merging remain in each consumer.

  `workflows-runtime/lib/run-store.ts` is deliberately excluded because it writes asynchronous,
  unknown-shaped run artifacts rather than settings documents. `tools-subagents/subagent-runner.ts`
  also retains its mutation-queue use because it serializes text prompt/task files, not settings.
