/**
 * Single-entry cache for the isolated Guardian session.
 *
 * Callers serialize `get` operations. A replacement is published only after it
 * is created successfully, so configuration errors leave the prior session
 * available.
 */
export class GuardianSessionCache<T extends { dispose(): void }> {
	private current: { key: string; value: T } | undefined;

	async get(key: string, create: () => Promise<T>): Promise<T> {
		if (this.current?.key === key) return this.current.value;

		const replacement = await create();
		const previous = this.current;
		this.current = { key, value: replacement };
		previous?.value.dispose();
		return replacement;
	}

	dispose(): void {
		this.current?.value.dispose();
		this.current = undefined;
	}
}
