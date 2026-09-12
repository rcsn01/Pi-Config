/**
 * Status-line registry shared by extensions and ui-footer.
 *
 * Extensions are loaded with fresh jiti instances, so ordinary module state is
 * local to one extension. The registry lives on `globalThis` under a
 * `Symbol.for` key, which resolves identically across those module copies.
 *
 * Canonical status order and style:
 *   profile 10 muted, approval-mode 20 muted, plan 30 accent,
 *   plan-pending 40 accent, plan-runtime 50 warning, workflow 60 accent,
 *   side-mode 70 accent, advisor 80 muted right, cache-effort 90 muted.
 *
 * Re-declaring an id replaces its previous declaration. This makes identical
 * declarations idempotent and gives conflicting declarations a deterministic
 * last-wins rule. Undeclared ids use muted style, tail order, and left
 * placement.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export interface StatusDeclaration {
	readonly id: string;
	readonly style: ThemeColor;
	readonly order: number;
	readonly placement?: "left" | "right";
}

export interface StatusRegistry {
	declare(declaration: StatusDeclaration): void;
	declarations(): readonly StatusDeclaration[];
	style(id: string): ThemeColor;
	order(id: string): number;
	placement(id: string): "left" | "right";
}

export function createStatusRegistry(): StatusRegistry {
	const declarations = new Map<string, StatusDeclaration>();

	return {
		declare(declaration): void {
			declarations.set(declaration.id, declaration);
		},
		declarations(): readonly StatusDeclaration[] {
			return [...declarations.values()].sort(
				(left, right) => (left.order - right.order) || left.id.localeCompare(right.id),
			);
		},
		style(id): ThemeColor {
			return declarations.get(id)?.style ?? "muted";
		},
		order(id): number {
			return declarations.get(id)?.order ?? Number.POSITIVE_INFINITY;
		},
		placement(id): "left" | "right" {
			return declarations.get(id)?.placement ?? "left";
		},
	};
}

const REGISTRY_KEY = Symbol.for("pi-config.status-registry.v1");

function getGlobalRegistry(): StatusRegistry {
	const globals = globalThis as typeof globalThis & { [REGISTRY_KEY]?: StatusRegistry };
	return globals[REGISTRY_KEY] ??= createStatusRegistry();
}

export function getStatusRegistry(): StatusRegistry {
	return getGlobalRegistry();
}

export function declareStatus(declaration: StatusDeclaration): void {
	getStatusRegistry().declare(declaration);
}
