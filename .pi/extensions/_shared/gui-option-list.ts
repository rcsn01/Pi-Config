export type GuiOptionListSelectionMode = "single" | "multiple";

export interface GuiOptionListOption<T extends string = string> {
	label: string;
	value: T;
	description?: string;
	checked?: boolean;
	disabled?: boolean;
}

export interface GuiOptionListRequest<T extends string = string> {
	title: string;
	message?: string;
	selectionMode?: GuiOptionListSelectionMode;
	options: Array<GuiOptionListOption<T>>;
}

type UiContext = {
	hasUI?: boolean;
	ui: {
		select?: (title: string, options: string[]) => Promise<string | undefined>;
		notify?: (message: string, level?: string) => void;
		[key: string]: unknown;
	};
};

type GuiOptionListResponse<T extends string = string> =
	| { value?: T; values?: T[]; cancelled?: boolean }
	| T
	| T[]
	| undefined;

function normalizeResponse<T extends string>(response: GuiOptionListResponse<T>): T | T[] | undefined {
	if (!response) return undefined;
	if (typeof response === "string") return response as T;
	if (Array.isArray(response)) return response;
	if (response.cancelled) return undefined;
	if (Array.isArray(response.values)) return response.values;
	if (typeof response.value === "string") return response.value as T;
	return undefined;
}

function fallbackLabel(option: GuiOptionListOption): string {
	const prefix = option.checked ? "● " : "  ";
	const suffix = option.checked ? " (current)" : "";
	const description = option.description ? ` — ${option.description}` : "";
	return `${prefix}${option.label}${description}${suffix}`;
}

async function requestStructuredOptionList<T extends string>(
	ctx: UiContext,
	request: Required<Pick<GuiOptionListRequest<T>, "selectionMode">> & GuiOptionListRequest<T>,
): Promise<{ supported: boolean; result: T | T[] | undefined }> {
	const ui = ctx.ui as Record<string, unknown>;
	const payload = {
		method: request.selectionMode === "multiple" ? "checklist" : "optionList",
		title: request.title,
		message: request.message,
		selectionMode: request.selectionMode,
		options: request.options,
	};

	for (const methodName of ["request", "customRequest", "sendRequest"]) {
		const method = ui[methodName];
		if (typeof method !== "function") continue;
		const response = await (method as (payload: unknown) => Promise<GuiOptionListResponse<T>>)(payload);
		return { supported: true, result: normalizeResponse(response) };
	}

	return { supported: false, result: undefined };
}

export async function pickGuiOption<T extends string>(
	ctx: UiContext,
	request: Omit<GuiOptionListRequest<T>, "selectionMode">,
): Promise<T | undefined> {
	const structured = await requestStructuredOptionList(ctx, { ...request, selectionMode: "single" });
	if (structured.supported) {
		if (typeof structured.result === "string") return structured.result;
		if (Array.isArray(structured.result)) return structured.result[0];
		return undefined;
	}

	const select = ctx.ui.select;
	if (typeof select !== "function") return undefined;
	const enabledOptions = request.options.filter((option) => !option.disabled);
	const labels = enabledOptions.map(fallbackLabel);
	const choice = await select(request.title, labels);
	if (!choice) return undefined;
	return enabledOptions[labels.indexOf(choice)]?.value;
}

export async function pickGuiOptions<T extends string>(
	ctx: UiContext,
	request: Omit<GuiOptionListRequest<T>, "selectionMode">,
): Promise<T[] | undefined> {
	const structured = await requestStructuredOptionList(ctx, { ...request, selectionMode: "multiple" });
	if (structured.supported) {
		if (Array.isArray(structured.result)) return structured.result;
		if (typeof structured.result === "string") return [structured.result];
		return undefined;
	}

	const select = ctx.ui.select;
	if (typeof select !== "function") {
		ctx.ui.notify?.("This UI does not support multiple-choice option lists.", "warning");
		return undefined;
	}

	const enabledOptions = request.options.filter((option) => !option.disabled);
	const selected = new Set<T>(enabledOptions.filter((option) => option.checked).map((option) => option.value));
	while (true) {
		const labels = [
			...enabledOptions.map((option) => fallbackLabel({ ...option, checked: selected.has(option.value) })),
			"✓ Save selected",
			"✗ Cancel",
		];
		const choice = await select(request.title, labels);
		if (!choice) return undefined;
		const saveIndex = enabledOptions.length;
		const cancelIndex = enabledOptions.length + 1;
		const index = labels.indexOf(choice);
		if (index === saveIndex) return Array.from(selected);
		if (index === cancelIndex) return undefined;
		const option = enabledOptions[index];
		if (!option) continue;
		if (selected.has(option.value)) selected.delete(option.value);
		else selected.add(option.value);
	}
}
