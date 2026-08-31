export const DASHBOARD_CLIENT_HELPERS = String.raw`
function dashboardRequiresLifecycle(requests, { fatal, content, message, disable = [] } = {}) {
	if (requests) return true;

	fatal.hidden = false;
	fatal.removeAttribute('hidden');
	fatal.classList?.remove('hidden');
	fatal.textContent = message;
	content.hidden = true;
	content.setAttribute('hidden', '');
	for (const id of disable) {
		const control = document.getElementById(id);
		if (!control) continue;
		control.disabled = true;
		control.setAttribute('disabled', '');
	}
	return false;
}

function dashElement(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined && text !== null) node.textContent = String(text);
	return node;
}

function dashFormatInteger(value) {
	return Number(value || 0).toLocaleString();
}

function dashFormatCompact(value) {
	const number = Number(value || 0);
	if (!Number.isFinite(number)) return '0';
	const absolute = Math.abs(number);
	const format = (divisor, suffix) => {
		const scaled = number / divisor;
		return scaled.toFixed(scaled >= 100 ? 0 : 1).replace(/\.0$/, '') + suffix;
	};
	if (absolute >= 1e9) return format(1e9, 'bn');
	if (absolute >= 1e6) return format(1e6, 'm');
	if (absolute >= 1e3) return format(1e3, 'k');
	return dashFormatInteger(number);
}

function dashCreateTablist({ host, tabs, initialKey, buttonClass = '', ariaLabel, controls, countOf, onActivate } = {}) {
	let activeKey = tabs.some((tab) => tab.key === initialKey) ? initialKey : tabs[0]?.key;
	const buttons = [];

	if (ariaLabel !== undefined) host.setAttribute('aria-label', ariaLabel);

	function update() {
		tabs.forEach((tab, index) => {
			const button = buttons[index];
			const selected = tab.key === activeKey;
			const count = countOf ? countOf(tab.key) : '';
			button.textContent = tab.label + (count == null ? '' : String(count));
			button.setAttribute('aria-selected', String(selected));
			button.setAttribute('tabindex', selected ? '0' : '-1');
			button.classList.toggle('dash-tab-selected', selected);
		});
	}

	function focus(key = activeKey) {
		const index = tabs.findIndex((tab) => tab.key === key);
		const button = index === -1 ? undefined : buttons[index];
		button?.focus();
		return button;
	}

	function activate(tab, focused) {
		activeKey = tab.key;
		update();
		onActivate?.(tab, { focused });
	}

	tabs.forEach((tab, index) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = buttonClass;
		button.setAttribute('role', 'tab');
		button.id = 'tab-' + tab.key;
		button.dataset.tab = tab.key;
		if (controls !== undefined) button.setAttribute('aria-controls', controls);
		button.addEventListener('click', () => activate(tab, false));
		button.addEventListener('keydown', (event) => {
			if (!tabs.length) return;
			let nextIndex;
			if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
			else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
			else if (event.key === 'Home') nextIndex = 0;
			else if (event.key === 'End') nextIndex = tabs.length - 1;
			else return;
			event.preventDefault();
			activate(tabs[nextIndex], true);
		});
		buttons.push(button);
		host.append(button);
	});
	update();
	return { update, focus };
}
`;
