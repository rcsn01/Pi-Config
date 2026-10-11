/** One FIFO process budget shared by every invocation in an execution instance. */
export function createSubagentExecutionScheduler(initialLimit = 4) {
	let limit = initialLimit;
	let active = 0;
	interface Entry { start(): void; signal?: AbortSignal; abort(): void }
	const queue: Entry[] = [];
	function drain() {
		while (active < limit && queue.length) queue.shift()!.start();
	}
	return {
		setLimit(value: number) {
			if (!Number.isInteger(value) || value < 1) throw new Error("Concurrency must be a positive integer.");
			limit = value;
			drain();
		},
		run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				if (signal?.aborted) { reject(signal.reason ?? new Error("Subagent cancelled")); return; }
				const entry: Entry = {
					signal,
					abort() {
						const index = queue.indexOf(entry);
						if (index < 0) return;
						queue.splice(index, 1);
						signal?.removeEventListener("abort", entry.abort);
						reject(signal?.reason ?? new Error("Subagent cancelled"));
					},
					start() {
						signal?.removeEventListener("abort", entry.abort);
						active++;
						void (async () => {
							try { resolve(await work()); }
							catch (error) { reject(error); }
							finally { active--; drain(); }
						})();
					},
				};
				queue.push(entry);
				signal?.addEventListener("abort", entry.abort, { once: true });
				drain();
			});
		},
	};
}
