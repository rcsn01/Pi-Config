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
