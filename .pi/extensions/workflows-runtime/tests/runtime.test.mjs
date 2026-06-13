import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const definition = await import('../lib/definition.ts');
const registry = await import('../lib/registry.ts');
const approval = await import('../lib/approval.ts');
const runStore = await import('../lib/run-store.ts');

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-test-'));
}

test('defineWorkflow accepts valid definitions and normalizes phases/capabilities', () => {
  const wf = definition.defineWorkflow({
    name: 'valid-workflow',
    description: 'Does useful work',
    phases: ['one', { name: 'two', description: 'second' }],
    budget: { maxAgents: 1, maxConcurrent: 1, maxTokens: 100, estimatedCost: 'quick' },
    canEditFiles: false,
    run() { return 'ok'; },
  });
  assert.equal(wf.name, 'valid-workflow');
  assert.deepEqual(wf.phases.map((p) => p.name), ['one', 'two']);
  assert.equal(wf.capabilities.canEditFiles, false);
});

test('defineWorkflow rejects invalid definitions', () => {
  const base = { name: 'valid-workflow', description: 'ok', canEditFiles: false, run() {} };
  assert.throws(() => definition.defineWorkflow({ ...base, name: 'BadName' }), /kebab-case/);
  assert.throws(() => definition.defineWorkflow({ ...base, name: 'resume' }), /reserved/);
  assert.throws(() => definition.defineWorkflow({ ...base, description: ' ' }), /non-empty description/);
  assert.throws(() => definition.defineWorkflow({ ...base, phases: [{}] }), /phase 1/);
  assert.throws(() => definition.defineWorkflow({ ...base, budget: { maxTokens: 0 } }), /maxTokens/);
  assert.throws(() => definition.defineWorkflow({ ...base, canEditFiles: undefined, capabilities: undefined }), /capabilities or canEditFiles/);
  assert.throws(() => definition.defineWorkflow({ ...base, run: undefined }), /run\(ctx\)/);
});

test('registry discovers bundled workflows and treats project workflows as metadata', async () => {
  const cwd = await tempProject();
  try {
    await mkdir(path.join(cwd, '.pi', 'workflows'), { recursive: true });
    await writeFile(path.join(cwd, '.pi', 'workflows', 'project-demo.js'), 'throw new Error("should not import during discovery");\nexport default {};\n');
    const entries = await registry.discoverWorkflows(cwd);
    for (const name of ['fan-out-and-synthesize', 'deep-verification', 'deep-research', 'generate-filter-tournament']) {
      assert.ok(entries.some((e) => e.name === name && e.trust === 'bundled'), `missing bundled workflow ${name}`);
    }
    const project = entries.find((e) => e.name === 'project-demo');
    assert.ok(project);
    assert.equal(project.trust, 'project');
    assert.equal(project.workflow, undefined);
    assert.match(project.sourceHash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('approval cache keys include project path hash, workflow name, and source hash', async () => {
  const cwdA = await tempProject();
  const cwdB = await tempProject();
  try {
    const entry = { name: 'demo', trust: 'project', description: 'demo', cost: 'medium', canEditFiles: false, source: 'a', sourceHash: registry.hash('a') };
    const keyA = approval.approvalKey(cwdA, entry);
    const keyB = approval.approvalKey(cwdB, entry);
    assert.equal(keyA.workflowName, 'demo');
    assert.equal(keyA.sourceHash, entry.sourceHash);
    assert.notEqual(keyA.projectHash, keyB.projectHash);
    assert.notEqual(approval.approvalPath(cwdA, entry), approval.approvalPath(cwdA, { ...entry, sourceHash: registry.hash('b') }));
  } finally {
    await rm(cwdA, { recursive: true, force: true });
    await rm(cwdB, { recursive: true, force: true });
  }
});

test('project workflow import uses approved snapshot and enforces filename-derived name', async () => {
  const cwd = await tempProject();
  try {
    const root = path.join(cwd, '.pi', 'workflow-runs', 'run-1');
    const entry = {
      name: 'project-demo',
      trust: 'project',
      description: 'Project workflow',
      cost: 'unknown',
      canEditFiles: undefined,
      extension: '.mjs',
      filePath: path.join(cwd, '.pi', 'workflows', 'project-demo.mjs'),
      sourceHash: registry.hash('snapshot'),
      source: 'export default { name: "project-demo", description: "from snapshot", canEditFiles: false, run() { return "snapshot"; } };\n',
    };
    const snapshot = await registry.writeWorkflowSnapshot(root, entry);
    await mkdir(path.dirname(entry.filePath), { recursive: true });
    await writeFile(entry.filePath, 'export default { name: "project-demo", description: "changed", canEditFiles: false, run() { return "changed"; } };\n');
    const workflow = await registry.loadWorkflowFromEntry(entry, snapshot);
    assert.equal(workflow.description, 'from snapshot');

    const badEntry = {
      ...entry,
      sourceHash: registry.hash('bad'),
      source: 'export default { name: "wrong-name", description: "bad", canEditFiles: false, run() {} };\n',
    };
    const badSnapshot = await registry.writeWorkflowSnapshot(path.join(cwd, '.pi', 'workflow-runs', 'run-2'), badEntry);
    await assert.rejects(() => registry.loadWorkflowFromEntry(badEntry, badSnapshot), /must match filename-derived invocation name/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('run store projects progress, reuse, pause, dependencies, and agent running counts', async () => {
  const cwd = await tempProject();
  try {
    const entry = { name: 'demo', trust: 'bundled', description: 'demo', cost: 'quick', canEditFiles: false, source: 'source', sourceHash: registry.hash('source') };
    const store = new runStore.RunStore(cwd, 'run-events');
    await store.initialize(entry, 'args', path.join(cwd, 'source.txt'));
    await store.append({ type: 'run_started' });
    await store.append({ type: 'step_started', key: 's1', dependsOn: ['a1'] });
    await store.append({ type: 'step_completed', key: 's1', result: 'done' });
    await store.append({ type: 'step_reused', key: 's1' });
    await store.append({ type: 'agent_started', key: 'a1', agent: 'default', dependsOn: ['root'], prompt: 'hello' });
    await store.append({ type: 'agent_progress', key: 'a1', event: { type: 'message', message: 'hi' } });
    await store.append({ type: 'agent_tool', key: 'a1', tool: 'read', args: 'file' });
    await store.append({ type: 'agent_completed', key: 'a1', agent: 'default', result: 'ok', usage: { input: 3, output: 4, cost: 0.01, turns: 1 } });
    await store.append({ type: 'agent_reused', key: 'a1', agent: 'default' });
    await store.append({ type: 'run_pausing', mode: 'after-current' });
    await store.append({ type: 'run_paused' });
    const state = await runStore.rebuildStateFromEvents(store.paths.events);
    assert.equal(state.status, 'paused');
    assert.equal(state.steps.s1.status, 'completed');
    assert.equal(state.agents.a1.status, 'completed');
    assert.equal(state.agentsRunning, 0);
    assert.equal(state.tokens, 7);
    assert.equal(state.dependencies.a1.includes('s1'), true);
    assert.equal(state.dependencies.root.includes('a1'), true);
    assert.ok(state.agents.a1.progress.length >= 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('run store appends JSONL, rebuilds state, handles invalidation, and protects artifacts', async () => {
  const cwd = await tempProject();
  try {
    const entry = { name: 'demo', trust: 'bundled', description: 'demo', cost: 'quick', canEditFiles: false, source: 'source', sourceHash: registry.hash('source') };
    const store = new runStore.RunStore(cwd, 'run-1');
    await store.initialize(entry, 'args', path.join(cwd, 'source.txt'));
    await store.append({ type: 'step_started', key: 's1' });
    await store.append({ type: 'step_completed', key: 's1', result: 42 });
    await store.append({ type: 'invalidated', key: 's1' });
    let state = await runStore.rebuildStateFromEvents(store.paths.events);
    assert.equal(state.steps.s1.status, 'invalidated');
    await store.append({ type: 'step_completed', key: 's1', result: 43 });
    state = await runStore.rebuildStateFromEvents(store.paths.events);
    assert.equal(state.steps.s1.result, 43);
    assert.deepEqual(state.invalidatedKeys, []);
    assert.throws(() => runStore.safeArtifactPath(store.paths.artifacts, '../escape.txt'), /escapes/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
