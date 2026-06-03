/**
 * Shell Completions Extension - Recreates Codex's shell completion generation
 *
 * Commands:
 *   /completions bash    - Generate bash completions for pi
 *   /completions zsh     - Generate zsh completions for pi
 *   /completions fish    - Generate fish completions for pi
 *   /completions install - Install completions for detected shell
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function generateBashCompletions(): string {
	return `# pi bash completions
_pi_completions() {
  local cur prev opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  opts="-h --help -v --version -p --print -r --resume -c --continue -e --extension --model --cd -n --name --no-session --fork --session --system-prompt"

  if [[ \${cur} == -* ]]; then
    COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
    return 0
  fi

  # Complete session files
  if [[ \${prev} == "--session" || \${prev} == "--fork" ]]; then
    local sessions_dir="\$HOME/.pi/agent/sessions"
    if [[ -d "\${sessions_dir}" ]]; then
      COMPREPLY=( $(compgen -f -- "\${sessions_dir}/\${cur}") )
      return 0
    fi
  fi

  COMPREPLY=( $(compgen -f -- \${cur}) )
  return 0
}
complete -F _pi_completions pi`;
}

function generateZshCompletions(): string {
	return `# pi zsh completions
#compdef pi

_pi() {
  local -a opts
  opts=(
    '-h[Show help]'
    '--help[Show help]'
    '-v[Show version]'
    '--version[Show version]'
    '-p[Print mode (non-interactive)]'
    '--print[Print mode]'
    '-r[Resume session]'
    '--resume[Resume session]'
    '-c[Continue most recent session]'
    '--continue[Continue most recent session]'
    '-e[Load extension]:extension file:_files -g "*.ts"'
    '--extension[Load extension]:extension file:_files -g "*.ts"'
    '--model[Model to use]:model:'
    '--cd[Working directory]:directory:_directories'
    '-n[Session name]:name:'
    '--name[Session name]:name:'
    '--no-session[Ephemeral mode]'
    '--fork[Fork session]:session file:_files'
    '--session[Session to use]:session file:_files'
    '--system-prompt[Custom system prompt]:prompt:'
  )
  _arguments -S $opts
}

_pi "$@"`;
}

function generateFishCompletions(): string {
	return `# pi fish completions
complete -c pi -s h -l help -d "Show help"
complete -c pi -s v -l version -d "Show version"
complete -c pi -s p -l print -d "Print mode (non-interactive)"
complete -c pi -s r -l resume -d "Resume session"
complete -c pi -s c -l continue -d "Continue most recent session"
complete -c pi -s e -l extension -d "Load extension" -r -a "(find . -name '*.ts' -maxdepth 3)"
complete -c pi -l model -d "Model to use" -r
complete -c pi -l cd -d "Working directory" -r -a "(ls -d */)"
complete -c pi -s n -l name -d "Session name" -r
complete -c pi -l no-session -d "Ephemeral mode"
complete -c pi -l fork -d "Fork session" -r
complete -c pi -l session -d "Session to use" -r
complete -c pi -l system-prompt -d "Custom system prompt" -r
`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("completions", {
		description: "Generate shell completions (bash|zsh|fish|install)",
		handler: async (args, ctx) => {
			const shell = (args || "").trim().toLowerCase();

			if (!shell) {
				ctx.ui.notify(
					"Usage: /completions bash|zsh|fish|install",
					"info",
				);
				return;
			}

			if (shell === "install") {
				const detectedShell = path.basename(process.env.SHELL || "");
				let completion = "";
				let rcFile = "";

				switch (detectedShell) {
					case "bash":
						completion = generateBashCompletions();
						rcFile = path.join(os.homedir(), ".bashrc");
						break;
					case "zsh":
						completion = generateZshCompletions();
						rcFile = path.join(os.homedir(), ".zshrc");
						break;
					case "fish":
						completion = generateFishCompletions();
						rcFile = path.join(
							os.homedir(),
							".config/fish/completions/pi.fish",
						);
						break;
					default:
						ctx.ui.notify(
							`Unsupported or unknown shell: ${detectedShell}. Use /completions bash|zsh|fish directly.`,
							"warning",
						);
						return;
				}

				if (ctx.hasUI) {
					const confirmed = await ctx.ui.confirm(
						"Install shell completions?",
						`This will update ${rcFile}. A .bak backup will be created when the file already exists. Continue?`,
					);
					if (!confirmed) return;
				}

				// Write to file
				try {
					const dir = path.dirname(rcFile);
					if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
					if (fs.existsSync(rcFile)) {
						fs.copyFileSync(rcFile, `${rcFile}.bak`);
					}

					if (detectedShell === "fish") {
						fs.writeFileSync(rcFile, completion);
					} else {
						// Append to rc file if not already present
						const marker = "# pi completions";
						const existing = fs.existsSync(rcFile)
							? fs.readFileSync(rcFile, "utf-8")
							: "";
						if (!existing.includes(marker)) {
							fs.appendFileSync(rcFile, `\n${marker}\n${completion}\n`);
						} else {
							ctx.ui.notify(
								"Completions already installed in rc file. Source it or restart your shell.",
								"info",
							);
							return;
						}
					}

					ctx.ui.notify(
						`Shell completions installed for ${detectedShell}.\nSource ${rcFile} or restart your shell.`,
						"info",
					);
				} catch (e: any) {
					ctx.ui.notify(
						`Failed to install completions: ${e.message}`,
						"error",
					);
				}
				return;
			}

			let output = "";
			switch (shell) {
				case "bash":
					output = generateBashCompletions();
					break;
				case "zsh":
					output = generateZshCompletions();
					break;
				case "fish":
					output = generateFishCompletions();
					break;
				default:
					ctx.ui.notify(
						"Unknown shell. Use: bash, zsh, fish, or install",
						"warning",
					);
					return;
			}

			ctx.ui.notify(output, "info");
		},
	});
}
