import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RegistryEntry } from "./registry.ts";
import { APPROVALS_DIR, ensureDir, entrySource, projectPathHash, slugify } from "./registry.ts";
import { formatApprovalPlan } from "./ui.ts";

export function approvalKey(cwd: string, entry: RegistryEntry): { projectHash: string; workflowName: string; sourceHash: string } {
	return { projectHash: projectPathHash(cwd), workflowName: entry.name, sourceHash: entry.sourceHash };
}

export function approvalPath(cwd: string, entry: RegistryEntry): string {
	const key = approvalKey(cwd, entry);
	return path.join(cwd, APPROVALS_DIR, key.projectHash, `${slugify(key.workflowName)}-${key.sourceHash.slice(0, 16)}.json`);
}

export async function hasApproval(cwd: string, entry: RegistryEntry): Promise<boolean> {
	return fs.existsSync(approvalPath(cwd, entry));
}

export async function saveApproval(cwd: string, entry: RegistryEntry): Promise<void> {
	const file = approvalPath(cwd, entry);
	await ensureDir(path.dirname(file));
	await fs.promises.writeFile(file, JSON.stringify({
		...approvalKey(cwd, entry),
		trust: entry.trust,
		approvedAt: Date.now(),
	}, null, 2), "utf-8");
}

export async function removeApproval(cwd: string, entry: RegistryEntry): Promise<void> {
	await fs.promises.rm(approvalPath(cwd, entry), { force: true });
}

export async function approve(_pi: ExtensionAPI, ctx: ExtensionContext, entry: RegistryEntry, args: string): Promise<boolean> {
	if (await hasApproval(ctx.cwd, entry)) return true;

	const plan = formatApprovalPlan(entry, args);
	if (!ctx.hasUI) {
		ctx.ui.notify(`${plan}\n\nApproval required. Run interactively to approve this workflow.`, "warning");
		return false;
	}

	while (true) {
		const choice = await ctx.ui.select(`${plan}\n\nChoose workflow action:`, [
			"Run once",
			"Always allow in this project/source",
			"View source",
			"Cancel",
		]);
		if (!choice || choice === "Cancel") return false;
		if (choice === "View source") {
			ctx.ui.notify(entrySource(entry).slice(0, 12000), "info");
			continue;
		}
		if (choice === "Always allow in this project/source") await saveApproval(ctx.cwd, entry);
		return true;
	}
}
