export const ANALYSIS_PAGE_CLIENT = String.raw`
'use strict';

const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

const auth = { Authorization: 'Bearer ' + token };
const requestList = document.getElementById('requestList');
const detailPane = document.getElementById('detailPane');
const error = document.getElementById('error');

let summaries = [];
let selectedSequence = null;
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

	const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output || 1;
	const bar = div('bar');
	const segments = [
		['uncached', usage.input],
		['cache', usage.cacheRead],
		['write', usage.cacheWrite],
		['output', Math.max(0, usage.output - (usage.reasoning || 0))],
		['reasoning', usage.reasoning || 0],
	];
	segments.forEach(([className, count]) => {
		const segment = document.createElement('span');
		segment.className = className;
		segment.style.width = (100 * count / total) + '%';
		segment.title = className + ' ' + count;
		bar.append(segment);
	});
	box.append(bar);
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
	if (section.kind !== 'option') {
		const allocated = section.allocatedTokens || 0;
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
		: (section.allocatedTokens || 0) + ' estimated tokens';
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
	text(title, 'Captured request parts');
	box.append(
		title,
		div(
			'muted',
			'Expand a row to inspect the exact value sent in the provider payload. '
				+ 'Tool rows include each transmitted tool description and parameter schema. '
				+ 'Cache coloring is estimated because OpenAI reports only an aggregate prefix count.',
		),
	);

	const controls = div('section-controls');
	const expand = document.createElement('button');
	const collapse = document.createElement('button');
	expand.type = 'button';
	collapse.type = 'button';
	text(expand, 'Expand all');
	text(collapse, 'Collapse all');
	expand.addEventListener('click', () => {
		box.querySelectorAll('details.analysis-section').forEach((row) => {
			row.open = true;
		});
	});
	collapse.addEventListener('click', () => {
		box.querySelectorAll('details.analysis-section').forEach((row) => {
			row.open = false;
		});
	});
	controls.append(expand, collapse);
	box.append(controls);

	try {
		const root = JSON.parse(detail.requestJson);
		const groups = [
			['Prompt, tools, and conversation', detail.sections.filter((section) => section.kind !== 'option')],
			['Request options', detail.sections.filter((section) => section.kind === 'option')],
		];
		groups.forEach(([label, sections]) => {
			if (!sections.length) return;
			box.append(div('section-group', label));
			sections.forEach((section) => {
				const row = sectionDetails(section, root);
				if (openPointers.has(section.pointer)) row.open = true;
				box.append(row);
			});
		});
	} catch (caught) {
		box.append(div('alert', 'Could not parse the captured request JSON: ' + caught.message));
	}
	return box;
}

function expandedPointers() {
	return new Set(Array.from(
		detailPane.querySelectorAll('details.analysis-section[open]'),
		(row) => row.dataset.pointer,
	));
}

function itemFingerprint(item) {
	return [item.sequence, item.state, item.bytes, item.status, item.diagnostic].join(':');
}

function renderRequestList() {
	requestList.replaceChildren();
	summaries.forEach((item) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'request-row' + (item.sequence === selectedSequence ? ' selected' : '');
		button.setAttribute('aria-pressed', item.sequence === selectedSequence ? 'true' : 'false');

		const title = document.createElement('strong');
		text(title, '#' + item.sequence + ' ' + item.provider + '/' + item.model);
		const meta = document.createElement('span');
		text(meta, item.state + ' · ' + new Date(item.requestedAt).toLocaleTimeString());
		button.append(title, meta);
		button.addEventListener('click', () => {
			selectedSequence = item.sequence;
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
		text(heading, 'Request #' + item.sequence + ' · ' + detail.provider + '/' + detail.model);
		const grid = div('grid');
		grid.append(
			metric('Run / turn', detail.run + ' / ' + detail.turn),
			metric('API', detail.api),
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
		text(
			document.getElementById('activation'),
			data.activatedAt
				? 'Capturing requests completed after ' + new Date(data.activatedAt).toLocaleString()
				: 'Capture is not active.',
		);
		const paused = document.getElementById('paused');
		paused.classList.toggle('hidden', !data.paused);
		text(document.getElementById('pausedText'), data.diagnostic || 'Capture paused.');

		summaries = data.records.slice().reverse();
		if (!summaries.some((item) => item.sequence === selectedSequence)) {
			selectedSequence = summaries[0]?.sequence ?? null;
		}
		renderRequestList();

		const selected = summaries.find((item) => item.sequence === selectedSequence);
		if (!selected) {
			detailGeneration++;
			renderedFingerprint = null;
			detailPane.replaceChildren();
		} else if (renderedFingerprint !== itemFingerprint(selected)) {
			renderDetail(selected);
		}
	} catch (caught) {
		error.classList.remove('hidden');
		text(error, caught.message);
	}
}

document.getElementById('clear').addEventListener('click', async () => {
	await api('/api/clear', { method: 'POST' });
	await refresh();
});

if (!token) {
	error.classList.remove('hidden');
	text(error, 'The capability token is missing from the URL fragment.');
} else {
	refresh();
	setInterval(refresh, 1500);
}
`;
