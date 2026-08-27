import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface BorderEditor {
	borderColor: (text: string) => string;
}

interface RenderRequester {
	requestRender(): void;
}

/**
 * Pi copies the default editor's border onto custom editors after their factory
 * returns. Reapply the live thinking-level border after that copy completes.
 */
export function reapplyThinkingBorder(
	ctx: Pick<ExtensionContext, "thinkingLevel" | "ui">,
	editor: BorderEditor,
	tui: RenderRequester,
): void {
	queueMicrotask(() => {
		editor.borderColor = ctx.ui.theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off");
		tui.requestRender();
	});
}
