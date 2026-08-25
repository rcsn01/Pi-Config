export class AbortError extends Error {
	constructor(message = "Workflow stopped by abort signal") {
		super(message);
		this.name = "AbortError";
	}
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AbortError();
}

export class Semaphore {
	private active = 0;
	private waiters: Array<() => void> = [];
	private readonly limit: number;
	private readonly signal?: AbortSignal;

	constructor(limit: number, signal?: AbortSignal) {
		this.limit = limit;
		this.signal = signal;
	}

	async withSlot<T>(fn: () => Promise<T>): Promise<T> {
		throwIfAborted(this.signal);
		await this.acquire();
		try {
			throwIfAborted(this.signal);
			return await fn();
		} finally {
			this.release();
		}
	}

	private async acquire(): Promise<void> {
		throwIfAborted(this.signal);
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const wake = () => {
				this.signal?.removeEventListener("abort", onAbort);
				this.active++;
				resolve();
			};
			const onAbort = () => {
				this.waiters = this.waiters.filter((w) => w !== wake);
				reject(new AbortError());
			};
			this.waiters.push(wake);
			this.signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		const wake = this.waiters.shift();
		if (wake) wake();
	}
}
