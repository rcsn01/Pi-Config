export const ANALYSIS_PAGE_CLIENT = String.raw`
'use strict';

const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

const auth = { Authorization: 'Bearer ' + token };
const requestList = document.getElementById('requestList');
const detailPane = document.getElementById('detailPane');
const sourceTabs = document.getElementById('sourceTabs');
const sourcePanel = document.getElementById('sourcePanel');
const activation = document.getElementById('activation');
const error = document.getElementById('error');

const tabs = [
	{ channel: 'main', label: 'Main' },
	{ channel: 'subagent', label: 'Subagents' },
	{ channel: 'guardian', label: 'Guardian' },
	{ channel: 'compaction', label: 'Compaction' },
];
let summaries = [];
let activeChannel = 'main';
let selectedSequence = null;
const selections = new Map();
let renderedFingerprint = null;
let detailGeneration = 0;

function text(element, value) {
	element.textContent = value == null ? '' : String(value);
}

function div(className, value) {
	const element = document.createElement('div');
	if (className) element.className = className;
	text(element, value);
	return element;
}

async function api(path, options = {}) {
	const response = await fetch(path, {
		...options,
		headers: { ...auth, ...options.headers },
	});
	if (!response.ok) throw new Error('HTTP ' + response.status);
	return response.status === 204 ? null : response.json();
}

function fmt(number) {
	return Number(number || 0).toLocaleString();
}

function metric(label, value) {
	const element = div('metric');
	element.append(div('muted', label), div('', value));
	return element;
}

function usageBar(usage, className = '') {
	const bar = div('bar' + (className ? ' ' + className : ''));
	bar.setAttribute('role', 'img');
	if (!usage) {
		bar.classList.add('usage-unavailable');
		bar.title = 'Token usage not reported';
		bar.setAttribute('aria-label', bar.title);
		return bar;
	}
	const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
	const segments = [
		['uncached', 'Uncached input', usage.input],
		['cache', 'Cache hit', usage.cacheRead],
		['write', 'Cache write', usage.cacheWrite],
		['output', 'Output', Math.max(0, usage.output - (usage.reasoning || 0))],
		['reasoning', 'Reasoning output', usage.reasoning || 0],
	];
	const labels = [];
	segments.forEach(([segmentClass, label, count]) => {
		if (!count || !total) return;
		const percent = 100 * count / total;
		const segment = document.createElement('span');
		segment.className = segmentClass;
		segment.style.width = percent + '%';
		segment.title = label + ': ' + fmt(count) + ' tokens (' + percent.toFixed(1) + '%)';
		labels.push(segment.title);
		bar.append(segment);
	});
	bar.setAttribute('aria-label', labels.length ? labels.join(', ') : 'No token usage');
	return bar;
}

function usageView(usage) {
	const box = div('');
	const grid = div('grid');
	grid.append(
		metric('Uncached input', fmt(usage.input)),
		metric('Cache hit', fmt(usage.cacheRead)),
		metric('Cache write', fmt(usage.cacheWrite)),
		metric('Output', fmt(usage.output)),
		metric('Reasoning, subset of output', usage.reasoning == null ? 'not reported' : fmt(usage.reasoning)),
		metric('Total tokens', fmt(usage.totalTokens)),
		metric('Total cost', '$' + Number(usage.cost.total || 0).toFixed(6)),
	);
	box.append(grid);

	box.append(usageBar(usage));
	return box;
}

function rawDetails(title, json) {
	const details = document.createElement('details');
	const summary = document.createElement('summary');
	const content = document.createElement('pre');
	text(summary, title);
	text(content, json);
	details.append(summary, content);
	return details;
}

function pointerValue(root, pointer) {
	if (pointer === '') return root;
	return pointer.slice(1).split('/').reduce(
		(value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')],
		root,
	);
}

function displayValue(value) {
	if (typeof value === 'string') return value;
	const json = JSON.stringify(value, null, 2);
	return json === undefined ? 'Value is missing from the captured request.' : json;
}

function sectionDetails(section, root) {
	const details = document.createElement('details');
	details.className = 'analysis-section' + (section.kind === 'option' ? ' option-section' : '');
	details.dataset.pointer = section.pointer;

	const summary = document.createElement('summary');
	if (section.kind !== 'option' && section.allocatedTokens != null) {
		const allocated = section.allocatedTokens;
		const cached = section.cachedTokens || 0;
		const bar = div('section-bar');
		const hit = div('hit');
		const miss = div('miss');
		hit.style.width = (allocated ? 100 * cached / allocated : 0) + '%';
		miss.style.width = (allocated ? 100 * (allocated - cached) / allocated : 100) + '%';
		bar.append(hit, miss);
		summary.append(bar);
	}

	const label = document.createElement('span');
	label.className = 'section-label';
	const tokenText = section.kind === 'option'
		? section.kind
		: section.allocatedTokens == null
			? section.estimatedTokens + ' locally estimated tokens'
			: section.allocatedTokens + ' estimated tokens';
	text(label, section.label + ' · ' + tokenText + ' · ' + (section.pointer || '/'));
	summary.append(label);

	const content = document.createElement('pre');
	content.className = 'section-content';
	text(content, displayValue(pointerValue(root, section.pointer)));
	details.append(summary, content);
	return details;
}

function sectionView(detail, openPointers) {
	const box = div('sections');
	const title = document.createElement('h2');
	text(title, detail.apiLabel + ' request parts');
	let explanation = 'Expand a row to inspect the exact value sent in the provider payload. '
		+ 'Tool rows include each transmitted tool description and parameter schema.';
	if (detail.cachePlacement === 'estimated') {
		explanation += ' Section-level cache placement is estimated from aggregate provider usage and payload order.';
	}
	box.append(title, div('muted', explanation));

	const controls = div('section-controls');
	const expand = document.createElement('button');
	const collapse = document.createElement('button');
	expand.type = 'button';
	collapse.type = 'button';
	text(expand, 'Expand all');
	text(collapse, 'Collapse all');
	expand.addEventListener('click', () => {
		box.querySelectorAll('details.analysis-section, details.tool-section-group').forEach((row) => {
			row.open = true;
		});
	});
	collapse.addEventListener('click', () => {
		box.querySelectorAll('details.analysis-section, details.tool-section-group').forEach((row) => {
			row.open = false;
		});
	});
	controls.append(expand, collapse);
	box.append(controls);

	try {
		const root = JSON.parse(detail.requestJson);
		const promptSections = detail.sections.filter((section) => section.kind !== 'option' && section.kind !== 'tool');
		const toolSections = detail.sections.filter((section) => section.kind === 'tool');
		const optionSections = detail.sections.filter((section) => section.kind === 'option');

		if (promptSections.length) {
			box.append(div('section-group', 'Prompt and conversation'));
			promptSections.forEach((section) => {
				const row = sectionDetails(section, root);
				if (openPointers.has(section.pointer)) row.open = true;
				box.append(row);
			});
		}
		if (toolSections.length) {
			const tools = document.createElement('details');
			tools.className = 'tool-section-group';
			tools.dataset.pointer = '__tool_schemas__';
			tools.open = openPointers.has(tools.dataset.pointer);
			const summary = document.createElement('summary');
			text(summary, 'Tool schemas (' + toolSections.length + ')');
			tools.append(summary);
			toolSections.forEach((section) => {
				const row = sectionDetails(section, root);
				if (openPointers.has(section.pointer)) row.open = true;
				tools.append(row);
			});
			box.append(tools);
		}
		if (optionSections.length) {
			box.append(div('section-group', 'Request options'));
			optionSections.forEach((section) => {
				const row = sectionDetails(section, root);
				if (openPointers.has(section.pointer)) row.open = true;
				box.append(row);
			});
		}
	} catch (caught) {
		box.append(div('alert', 'Could not parse the captured request JSON: ' + caught.message));
	}
	return box;
}

function expandedPointers() {
	return new Set(Array.from(
		detailPane.querySelectorAll('details.analysis-section[open], details.tool-section-group[open]'),
		(row) => row.dataset.pointer,
	));
}

function itemFingerprint(item) {
	return [item.sequence, item.state, item.bytes, item.status, item.diagnostic].join(':');
}

function channelOf(item) {
	return item.source?.channel || 'main';
}

function visibleSummaries() {
	return summaries.filter((item) => channelOf(item) === activeChannel);
}

function renderTabs() {
	sourceTabs.replaceChildren();
	tabs.forEach((tab, index) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'source-tab';
		button.setAttribute('role', 'tab');
		button.id = 'tab-' + tab.channel;
		button.setAttribute('aria-controls', 'sourcePanel');
		button.setAttribute('aria-selected', tab.channel === activeChannel ? 'true' : 'false');
		button.setAttribute('tabindex', tab.channel === activeChannel ? '0' : '-1');
		button.dataset.channel = tab.channel;
		text(button, tab.label + ' (' + summaries.filter((item) => channelOf(item) === tab.channel).length + ')');
		button.addEventListener('click', () => {
			if (activeChannel === tab.channel) return;
			if (selectedSequence != null) selections.set(activeChannel, selectedSequence);
			activeChannel = tab.channel;
			sourcePanel.setAttribute('aria-labelledby', button.id);
			const visible = visibleSummaries();
			const saved = selections.get(activeChannel);
			selectedSequence = visible.some((item) => item.sequence === saved) ? saved : (visible[0]?.sequence ?? null);
			renderedFingerprint = null;
			renderTabs();
			renderRequestList();
			const selected = visible.find((item) => item.sequence === selectedSequence);
			if (selected) renderDetail(selected);
			else {
				detailGeneration++;
				detailPane.removeAttribute('data-sequence');
				detailPane.replaceChildren(div('empty-state', 'No captured requests for ' + tab.label + '.'));
			}
		});
		button.addEventListener('keydown', (event) => {
			let targetIndex;
			if (event.key === 'ArrowRight') targetIndex = (index + 1) % tabs.length;
			else if (event.key === 'ArrowLeft') targetIndex = (index - 1 + tabs.length) % tabs.length;
			else if (event.key === 'Home') targetIndex = 0;
			else if (event.key === 'End') targetIndex = tabs.length - 1;
			else return;
			event.preventDefault();
			const channel = tabs[targetIndex].channel;
			sourceTabs.querySelector('[data-channel="' + channel + '"]').click();
			sourceTabs.querySelector('[data-channel="' + channel + '"]').focus();
		});
		sourceTabs.append(button);
	});
}

function renderRequestList() {
	requestList.replaceChildren();
	const visible = visibleSummaries();
	if (!visible.length) {
		requestList.append(div('empty-state', 'No requests captured in this tab.'));
		return;
	}
	visible.forEach((item) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'request-row' + (item.sequence === selectedSequence ? ' selected' : '');
		button.setAttribute('aria-pressed', item.sequence === selectedSequence ? 'true' : 'false');

		const title = document.createElement('strong');
		text(title, '#' + item.sequence + ' ' + (item.source?.displayLabel || item.provider) + ' · ' + item.provider + '/' + item.model);
		const meta = document.createElement('span');
		text(meta, item.apiLabel + ' · ' + item.state + ' · ' + new Date(item.requestedAt).toLocaleTimeString());
		button.append(title, meta, usageBar(item.usage, 'request-usage-bar'));
		button.addEventListener('click', () => {
			selectedSequence = item.sequence;
			selections.set(activeChannel, selectedSequence);
			renderedFingerprint = null;
			renderRequestList();
			renderDetail(item);
		});
		requestList.append(button);
	});
}

async function renderDetail(item) {
	const generation = ++detailGeneration;
	const fingerprint = itemFingerprint(item);
	const openPointers = detailPane.dataset.sequence === String(item.sequence)
		? expandedPointers()
		: new Set();
	detailPane.dataset.sequence = String(item.sequence);
	renderedFingerprint = fingerprint;
	detailPane.replaceChildren(div('status', 'Loading request #' + item.sequence + '...'));

	try {
		const detail = await api('/api/records/' + item.sequence);
		if (generation !== detailGeneration || selectedSequence !== item.sequence) return;

		const heading = document.createElement('h2');
		text(heading, (detail.source?.channel === 'compaction' ? 'Compaction #' : 'Request #') + item.sequence + ' · ' + detail.provider + '/' + detail.model);
		const grid = div('grid');
		grid.append(
			metric('Source', (detail.source?.displayLabel || 'Main agent') + ' · ' + (detail.source?.invocationId || 'legacy')),
			metric('Run / turn', detail.run + ' / ' + detail.turn),
			metric('API', detail.api),
			metric('Payload type', detail.apiLabel),
			metric('Payload fidelity', detail.fidelity === 'pi-preparation' ? 'Pi-level preparation, not exact provider payload' : 'Exact provider payload'),
			metric(
				'HTTP status',
				detail.status == null ? (detail.statusEvidence?.join(', ') || 'unavailable') : detail.status,
			),
			metric('Correlation', detail.correlation),
			metric('Retained bytes', fmt(detail.bytes)),
		);
		detailPane.replaceChildren(heading, grid);

		if (detail.diagnostic) detailPane.append(div('alert', detail.diagnostic));
		if (detail.usage) {
			const usageHeading = document.createElement('h2');
			text(usageHeading, 'Exact provider-reported usage');
			detailPane.append(usageHeading, usageView(detail.usage));
		}
		detailPane.append(
			sectionView(detail, openPointers),
			rawDetails('Complete logical request JSON', detail.requestJson),
		);
		if (detail.assistantJson) {
			detailPane.append(rawDetails('Complete Pi-normalized assistant JSON', detail.assistantJson));
		}
	} catch (caught) {
		if (generation !== detailGeneration) return;
		renderedFingerprint = null;
		detailPane.replaceChildren(div('alert', caught.message));
	}
}

async function refresh() {
	try {
		const data = await api('/api/summary');
		error.classList.add('hidden');
		activation.classList.toggle('hidden', Boolean(data.activatedAt));
		text(activation, data.activatedAt ? '' : 'Capture is not active.');
		const paused = document.getElementById('paused');
		paused.classList.toggle('hidden', !data.paused);
		text(document.getElementById('pausedText'), data.diagnostic || 'Capture paused.');

		summaries = data.records.slice().reverse();
		const visible = visibleSummaries();
		if (!visible.some((item) => item.sequence === selectedSequence)) {
			const saved = selections.get(activeChannel);
			selectedSequence = visible.some((item) => item.sequence === saved) ? saved : (visible[0]?.sequence ?? null);
		}
		if (selectedSequence != null) selections.set(activeChannel, selectedSequence);
		renderTabs();
		renderRequestList();

		const selected = visible.find((item) => item.sequence === selectedSequence);
		if (!selected) {
			detailGeneration++;
			renderedFingerprint = null;
			const label = tabs.find((tab) => tab.channel === activeChannel)?.label || activeChannel;
			detailPane.removeAttribute('data-sequence');
			detailPane.replaceChildren(div('empty-state', 'No captured requests for ' + label + '.'));
		} else if (renderedFingerprint !== itemFingerprint(selected)) {
			renderDetail(selected);
		}
	} catch (caught) {
		activation.classList.add('hidden');
		error.classList.remove('hidden');
		text(error, caught.message);
	}
}

document.getElementById('clear').addEventListener('click', async () => {
	await api('/api/clear', { method: 'POST' });
	await refresh();
});

if (!token) {
	activation.classList.add('hidden');
	error.classList.remove('hidden');
	text(error, 'The capability token is missing from the URL fragment.');
} else {
	refresh();
	setInterval(refresh, 1500);
}
`;
