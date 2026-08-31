export const ANALYSIS_PAGE_CLIENT = String.raw`
'use strict';

const requests = createDashboardRequestLifecycle();
const requestList = document.getElementById('requestList');
const detailPane = document.getElementById('detailPane');
const sourceTabs = document.getElementById('sourceTabs');
const sourcePanel = document.getElementById('sourcePanel');
const activation = document.getElementById('activation');
const error = document.getElementById('error');

const tabs = [
	{ key: 'main', label: 'Main' },
	{ key: 'subagent', label: 'Subagents' },
	{ key: 'guardian', label: 'Guardian' },
	{ key: 'compaction', label: 'Compaction' },
];
let summaries = [];
let activeChannel = 'main';
let selectedSequence = null;
const selections = new Map();
let renderedFingerprint = null;

const element = dashElement;
const fmt = dashFormatInteger;

function metric(label, value) {
	const box = element('div', 'metric');
	box.append(element('div', 'muted', label), element('div', '', value));
	return box;
}

function usageBar(usage, className = '') {
	const bar = element('div', 'bar' + (className ? ' ' + className : ''));
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
	const box = element('div', '');
	const grid = element('div', 'grid');
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
	summary.textContent = title == null ? '' : String(title);
	content.textContent = json == null ? '' : String(json);
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

function readableMessage(value, kind) {
	if (!['instruction', 'conversation', 'reasoning'].includes(kind)
		|| value === null || typeof value !== 'object' || Array.isArray(value)
		|| !Object.hasOwn(value, 'content')) return null;
	const fields = Object.entries(value)
		.filter(([key]) => key !== 'content')
		.map(([key, fieldValue]) => key + ': ' + (typeof fieldValue === 'string'
			? fieldValue
			: JSON.stringify(fieldValue, null, 2)));
	let content = value.content;
	if (Array.isArray(content)) {
		content = content.map((part, index) => {
			if (part && typeof part === 'object' && typeof part.text === 'string') {
				return '[' + (part.type || 'part ' + (index + 1)) + ']\n' + part.text;
			}
			return JSON.stringify(part, null, 2);
		}).join('\n\n');
	} else if (typeof content !== 'string') {
		content = JSON.stringify(content, null, 2);
	}
	return fields.concat('content:', content ?? '').join('\n');
}

function displayValue(value, kind) {
	if (typeof value === 'string') return value;
	const readable = readableMessage(value, kind);
	if (readable !== null) return readable;
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
		const bar = element('div', 'section-bar');
		const hit = element('div', 'hit');
		const miss = element('div', 'miss');
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
	label.textContent = section.label + ' · ' + tokenText + ' · ' + (section.pointer || '/');
	summary.append(label);

	const content = document.createElement('pre');
	content.className = 'section-content';
	content.textContent = displayValue(pointerValue(root, section.pointer), section.kind);
	details.append(summary, content);
	return details;
}

function sectionView(detail, openPointers) {
	const box = element('div', 'sections');
	const title = document.createElement('h2');
	title.textContent = detail.apiLabel + ' request parts';
	let explanation = 'Expand a row to inspect the exact value sent in the provider payload. '
		+ 'Tool rows include each transmitted tool description and parameter schema.';
	if (detail.cachePlacement === 'estimated') {
		explanation += ' Section-level cache placement is estimated from aggregate provider usage and payload order.';
	}
	box.append(title, element('div', 'muted', explanation));

	const controls = element('div', 'section-controls');
	const expand = document.createElement('button');
	const collapse = document.createElement('button');
	expand.type = 'button';
	collapse.type = 'button';
	expand.textContent = 'Expand all';
	collapse.textContent = 'Collapse all';
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
		const requestSections = detail.sections.filter((section) => section.kind !== 'option');
		const optionSections = detail.sections.filter((section) => section.kind === 'option');

		if (requestSections.length) {
			box.append(element('div', 'section-group', 'Prompt, tools, and conversation'));
			for (let index = 0; index < requestSections.length;) {
				const section = requestSections[index];
				if (section.kind !== 'tool') {
					const row = sectionDetails(section, root);
					if (openPointers.has(section.pointer)) row.open = true;
					box.append(row);
					index++;
					continue;
				}

				const toolSections = [];
				while (index < requestSections.length && requestSections[index].kind === 'tool') {
					toolSections.push(requestSections[index]);
					index++;
				}
				if (toolSections.length === 1) {
					const row = sectionDetails(toolSections[0], root);
					if (openPointers.has(toolSections[0].pointer)) row.open = true;
					box.append(row);
					continue;
				}
				const tools = document.createElement('details');
				tools.className = 'tool-section-group';
				tools.dataset.pointer = '__tool_schemas__' + toolSections[0].pointer;
				tools.open = openPointers.has(tools.dataset.pointer);
				const summary = document.createElement('summary');
				summary.textContent = 'Tool schemas (' + toolSections.length + ')';
				tools.append(summary);
				toolSections.forEach((toolSection) => {
					const row = sectionDetails(toolSection, root);
					if (openPointers.has(toolSection.pointer)) row.open = true;
					tools.append(row);
				});
				box.append(tools);
			}
		}
		if (optionSections.length) {
			box.append(element('div', 'section-group', 'Request options'));
			optionSections.forEach((section) => {
				const row = sectionDetails(section, root);
				if (openPointers.has(section.pointer)) row.open = true;
				box.append(row);
			});
		}
	} catch (caught) {
		box.append(element('div', 'alert', 'Could not parse the captured request JSON: ' + caught.message));
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

const sourceTablist = dashCreateTablist({
	host: sourceTabs,
	tabs,
	initialKey: activeChannel,
	buttonClass: 'source-tab',
	ariaLabel: 'Request sources',
	controls: 'sourcePanel',
	countOf: (channel) => ' (' + summaries.filter((item) => channelOf(item) === channel).length + ')',
	onActivate(tab, { focused }) {
		if (activeChannel === tab.key) {
			if (focused) sourceTablist.focus(tab.key);
			return;
		}
		if (selectedSequence != null) selections.set(activeChannel, selectedSequence);
		activeChannel = tab.key;
		sourcePanel.setAttribute('aria-labelledby', 'tab-' + tab.key);
		const visible = visibleSummaries();
		const saved = selections.get(activeChannel);
		selectedSequence = visible.some((item) => item.sequence === saved) ? saved : (visible[0]?.sequence ?? null);
		renderedFingerprint = null;
		renderRequestList();
		const selected = visible.find((item) => item.sequence === selectedSequence);
		if (selected) renderDetail(selected);
		else {
			requests?.cancel('detail');
			detailPane.removeAttribute('data-sequence');
			detailPane.replaceChildren(element('div', 'empty-state', 'No captured requests for ' + tab.label + '.'));
		}
		if (focused) sourceTablist.focus(tab.key);
	},
});

function renderRequestList() {
	requestList.replaceChildren();
	const visible = visibleSummaries();
	if (!visible.length) {
		requestList.append(element('div', 'empty-state', 'No requests captured in this tab.'));
		return;
	}
	visible.forEach((item) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'request-row dash-row' + (item.sequence === selectedSequence ? ' selected' : '');
		button.setAttribute('aria-pressed', item.sequence === selectedSequence ? 'true' : 'false');

		const title = document.createElement('strong');
		title.textContent = '#' + item.sequence + ' ' + (item.source?.displayLabel || item.provider) + ' · ' + item.provider + '/' + item.model;
		const meta = document.createElement('span');
		meta.textContent = item.apiLabel + ' · ' + item.state + ' · ' + new Date(item.requestedAt).toLocaleTimeString();
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

function renderDetail(item) {
	const fingerprint = itemFingerprint(item);
	const openPointers = detailPane.dataset.sequence === String(item.sequence)
		? expandedPointers()
		: new Set();
	detailPane.dataset.sequence = String(item.sequence);
	renderedFingerprint = fingerprint;
	detailPane.replaceChildren(element('div', 'status', 'Loading request #' + item.sequence + '...'));

	requests.read('detail', '/api/records/' + item.sequence, {
		success(detail) {
			if (selectedSequence !== item.sequence) return;

			const heading = document.createElement('h2');
			heading.textContent = (detail.source?.channel === 'compaction' ? 'Compaction #' : 'Request #') + item.sequence + ' · ' + detail.provider + '/' + detail.model;
			const grid = element('div', 'grid');
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

			if (detail.diagnostic) detailPane.append(element('div', 'alert', detail.diagnostic));
			if (detail.usage) {
				const usageHeading = document.createElement('h2');
				usageHeading.textContent = 'Exact provider-reported usage';
				detailPane.append(usageHeading, usageView(detail.usage));
			}
			detailPane.append(
				sectionView(detail, openPointers),
				rawDetails('Complete logical request JSON', detail.requestJson),
			);
			if (detail.assistantJson) {
				detailPane.append(rawDetails('Complete Pi-normalized assistant JSON', detail.assistantJson));
			}
		},
		failure(caught) {
			renderedFingerprint = null;
			detailPane.replaceChildren(element('div', 'alert', caught.message));
		},
	});
}

function refresh() {
	requests.read('summary', '/api/summary', {
		success(data) {
			error.classList.add('hidden');
			activation.classList.toggle('hidden', Boolean(data.activatedAt));
			activation.textContent = data.activatedAt ? '' : 'Capture is not active.';
			const paused = document.getElementById('paused');
			paused.classList.toggle('hidden', !data.paused);
			document.getElementById('pausedText').textContent = data.diagnostic || 'Capture paused.';

			summaries = data.records.slice().reverse();
			const visible = visibleSummaries();
			if (!visible.some((item) => item.sequence === selectedSequence)) {
				const saved = selections.get(activeChannel);
				selectedSequence = visible.some((item) => item.sequence === saved) ? saved : (visible[0]?.sequence ?? null);
			}
			if (selectedSequence != null) selections.set(activeChannel, selectedSequence);
			sourceTablist.update();
			renderRequestList();

			const selected = visible.find((item) => item.sequence === selectedSequence);
			if (!selected) {
				requests.cancel('detail');
				renderedFingerprint = null;
				const label = tabs.find((tab) => tab.key === activeChannel)?.label || activeChannel;
				detailPane.removeAttribute('data-sequence');
				detailPane.replaceChildren(element('div', 'empty-state', 'No captured requests for ' + label + '.'));
			} else if (renderedFingerprint !== itemFingerprint(selected)) {
				renderDetail(selected);
			}
		},
		failure(caught) {
			activation.classList.add('hidden');
			error.classList.remove('hidden');
			error.textContent = caught.message;
		},
	});
}

document.getElementById('clear').addEventListener('click', async () => {
	await requests.mutate('clear', '/api/clear', { method: 'POST' });
	refresh();
});

if (!dashboardRequiresLifecycle(requests, {
	fatal: error,
	content: sourcePanel,
	message: 'The capability token is missing from the URL fragment.',
	disable: ['clear'],
})) {
	activation.classList.add('hidden');
} else {
	refresh();
	setInterval(refresh, 1500);
}
`;
