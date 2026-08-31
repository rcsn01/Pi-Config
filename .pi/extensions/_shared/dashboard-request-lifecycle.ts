export const DASHBOARD_REQUEST_LIFECYCLE_CLIENT = String.raw`
function createDashboardRequestLifecycle() {
	const token = new URLSearchParams(location.hash.slice(1)).get('token');
	if (!token) return null;

	history.replaceState(null, '', location.pathname + (location.search || ''));
	const reads = new Map();
	const mutations = new Map();

	function requestError(kind, message, details = {}) {
		const error = new Error(message);
		error.name = 'DashboardRequestError';
		error.kind = kind;
		Object.assign(error, details);
		return error;
	}

	async function request(path, options = {}) {
		let response;
		try {
			const headers = new Headers(options.headers || {});
			headers.set('Authorization', 'Bearer ' + token);
			response = await fetch(path, {
				...options,
				headers,
			});
		} catch (caught) {
			if (caught && caught.name === 'AbortError') throw caught;
			const message = caught && caught.message ? caught.message : String(caught);
			throw requestError('network', message, { cause: caught });
		}

		if (!response.ok) {
			const suffix = response.statusText ? ' ' + response.statusText : '';
			throw requestError('http', 'HTTP ' + response.status + suffix, {
				status: response.status,
				statusText: response.statusText || '',
			});
		}
		if (response.status === 204) return null;
		try {
			return await response.json();
		} catch (caught) {
			const message = caught && caught.message ? caught.message : String(caught);
			throw requestError('decode', message, { cause: caught });
		}
	}

	function read(stream, path, callbacks, options = {}) {
		const previous = reads.get(stream);
		if (previous) previous.abort();

		const controller = new AbortController();
		reads.set(stream, controller);
		request(path, { ...options, signal: controller.signal }).then(
			(value) => {
				if (reads.get(stream) !== controller) return;
				reads.delete(stream);
				callbacks.success(value);
			},
			(error) => {
				if (reads.get(stream) !== controller) return;
				reads.delete(stream);
				if (controller.signal.aborted) return;
				callbacks.failure(error);
			},
		);
	}

	function cancel(stream) {
		const current = reads.get(stream);
		if (!current) return;
		reads.delete(stream);
		current.abort();
	}

	function mutate(name, path, options = {}) {
		const current = mutations.get(name);
		if (current) return current;

		let operation;
		operation = request(path, options).finally(() => {
			if (mutations.get(name) === operation) mutations.delete(name);
		});
		mutations.set(name, operation);
		return operation;
	}

	return Object.freeze({ read, cancel, mutate });
}
`;
