import { CustomEditor } from "@earendil-works/pi-coding-agent";

export type ModelCommandHandler = (args: string) => Promise<void>;

let activeModelCommandHandler: ModelCommandHandler | undefined;

/** Parse a standalone, single-line /model invocation without rewriting it. */
export function parseModelCommand(text: string): string | undefined {
	const command = text.trim();
	if (command.includes("\n")) return undefined;
	const match = /^\/model(?:\s+(.*))?$/.exec(command);
	return match ? (match[1] ?? "").trim() : undefined;
}

/** Install the selector used by editor extensions; returns an ownership-safe cleanup callback. */
export function installModelCommandHandler(handler: ModelCommandHandler): () => void {
	activeModelCommandHandler = handler;
	return () => {
		if (activeModelCommandHandler === handler) activeModelCommandHandler = undefined;
	};
}

export function getModelCommandHandler(): ModelCommandHandler | undefined {
	return activeModelCommandHandler;
}

/** Editor that silently intercepts /model before Pi's built-in command handler. */
export class ModelCommandRoutingEditor extends CustomEditor {
	private readonly routingKeybindings: ConstructorParameters<typeof CustomEditor>[2];
	private readonly modelCommandHandler: ModelCommandHandler | undefined;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		modelCommandHandler?: ModelCommandHandler,
	) {
		super(tui, theme, keybindings);
		this.routingKeybindings = keybindings;
		this.modelCommandHandler = modelCommandHandler;
	}

	override handleInput(data: string): void {
		if (this.modelCommandHandler && this.routingKeybindings.matches(data, "tui.input.submit")) {
			const args = parseModelCommand(this.getText());
			if (args !== undefined) {
				this.setText("");
				void this.modelCommandHandler(args);
				return;
			}
		}
		super.handleInput(data);
	}
}
