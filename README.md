# Pi-Config

Shared configuration for [pi](https://github.com/earendil-works/pi) — the coding agent. This repo holds one `.pi` directory containing extensions (custom tools, UI extensions, workflows) and settings, which other projects link to so they all share the same setup.

## Setup

Install the dependencies used by the extensions:

```bash
cd .pi
pnpm install
```

Verify everything works with:

```bash
pnpm typecheck
pnpm test
```

## Setting up other projects

Run the setup script and enter the path to each project you want to link:

- macOS/Linux: `./setup-projects.sh`
- Windows: `.\setup-projects.ps1`

This links the project's `.pi` directory to this repo's `.pi`, so it picks up the shared configuration.

## Experimental advisor

The opt-in `tools-advisor` extension lets the executor consult one stronger, read-only model without giving that model tools or edit access.

- `/advisor` opens the authenticated advisor-model picker.
- `/advisor <provider>/<model>` selects a model directly.
- `/advisor off` disables future consultations.

The default budget is three consultations per session. The advisor receives the executor system prompt, active tool manifest, conversation, code, and tool output; selecting a different provider requires explicit confirmation. Advice is experimental and remains disabled until configured in the `advisor` namespace of `.pi/settings.json`.

## Settings profiles

Complete project settings profiles live at `.pi/profiles/<name>.json`. A profile is a full settings document: switching profiles replaces `.pi/settings.json` rather than merging keys from multiple files.

Use:

- `/profile` to choose a profile interactively.
- `/profile <name>` to switch directly.

To create a profile, copy an existing file in `.pi/profiles`, rename the copy, and edit its settings. Edit the active profile through `.pi/settings.json`; changes made there—including changes from `/model`, `/subagents`, and `/settings`—are automatically written back to the active profile. Inactive profile files may be edited directly.

The `configProfiles.active` field is reserved for the profile extension. It identifies the active profile and is normalized during a switch while other settings and other fields under `configProfiles` are preserved.

Switching writes back the outgoing settings, replaces the complete active document, applies the new profile's saved model selection for the current mode (`uiModelSelector.profiles.normal` or `.plan`) to the current session, and reloads Pi's resources while retaining the current conversation. A plain `/reload` without a profile switch still preserves the session model.

Plan Mode reads its model from `uiModelSelector.profiles.plan` in the active `.pi/settings.json`. Model or thinking-level changes made while Plan Mode is active are saved back to that project setting; no separate global Plan Mode profile is used.
