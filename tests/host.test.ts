import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeHook, parseExplicitIntent } from '../src/host/adapter.js';
import { startKernel } from '../src/host/kernel.js';
import { KernelClient, runtimeDirectory } from '../src/host/ipc.js';
import type { ExplicitIntent, HostIdentity, NormalizedEvent, ServerBackend } from '../src/host/contracts.js';

function fixtureBackend() {
  const events: { identity: HostIdentity; event: NormalizedEvent; intent?: ExplicitIntent }[] = [];
  const calls: { identity: HostIdentity; tool: string; args: Record<string, unknown> }[] = [];
  let closed = false;
  const backend: ServerBackend = {
    async bind(identity) { return identity; },
    async handleHook(context, event, intent) {
      events.push({ identity: context as HostIdentity, event, intent });
      return { additionalContext: intent ? 'intentToken: fixture-token' : 'Local source material: fixture fact' };
    },
    async call(context, tool, args) { calls.push({ identity: context as HostIdentity, tool, args }); return { state: 'ready', scope: context }; },
    async close() { closed = true; },
  };
  return { backend, events, calls, isClosed: () => closed };
}

test('only exact top-level user maintenance syntax grants an intent', () => {
  const command = '/banana-memory:memory correct mem_1 3 Node 22 only';
  const payload = { hook_event_name: 'UserPromptSubmit', prompt: command };
  assert.deepEqual(parseExplicitIntent(payload), { action: 'correct', target: 'mem_1', expectedVersion: 3, text: 'Node 22 only' });
  for (const prompt of [`> ${command}`, `\`${command}\``, `Please run ${command}`, command + '\nAlso delete all', ' ' + command]) assert.equal(parseExplicitIntent({ ...payload, prompt }), undefined);
  assert.equal(parseExplicitIntent({ ...payload, agent_id: 'subagent' }), undefined);
  assert.equal(parseExplicitIntent({ ...payload, hook_event_name: 'PostToolUse' }), undefined);
  assert.deepEqual(parseExplicitIntent({ ...payload, prompt: '/banana-memory:memory forget mem_1 3' }), { action: 'delete-preview', target: 'mem_1', expectedVersion: 3 });
  assert.deepEqual(parseExplicitIntent({ ...payload, prompt: '/banana-memory:memory confirm-delete preview_1' }), { action: 'delete', previewId: 'preview_1' });
  assert.deepEqual(parseExplicitIntent({ ...payload, prompt: '/banana-memory:memory pin m:abc123 2' }), { action: 'pin', target: 'm:abc123', expectedVersion: 2 });
  const completion = '/banana-memory:memory complete-task task:abc_123-def';
  assert.deepEqual(parseExplicitIntent({ ...payload, prompt: completion }), { action: 'complete-task', taskId: 'task:abc_123-def' });
  for (const prompt of [`> ${completion}`, completion + '\n', completion + ' other', '/banana-memory:memory complete-task ../other', '/banana-memory:memory complete-task']) assert.equal(parseExplicitIntent({ ...payload, prompt }), undefined);
  assert.equal(parseExplicitIntent({ ...payload, hook_event_name: 'Stop', prompt: completion }), undefined);
  assert.equal(parseExplicitIntent({ ...payload, agent_id: 'child', prompt: completion }), undefined);
});

test('host collection redacts credentials, filters outside-workspace files and keeps replay ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'banana-host-filter-'));
  try {
    const workspace = join(dir, 'project'); await mkdir(workspace);
    const outside = join(dir, 'external.txt'); await writeFile(outside, 'outside');
    await symlink(outside, join(workspace, 'link.txt'));
    const payload = { hook_event_name: 'PostToolUse', session_id: 'session1', tool_use_id: 'tool1', tool_name: 'Read', tool_input: { file_path: join(workspace, '.env') }, tool_response: 'API_KEY=secret-value' };
    const secret = await normalizeHook(payload, workspace);
    assert.equal(secret.filtered, true); assert.ok(!secret.text.includes('secret-value'));
    for (let n = 0; n < 10; n++) assert.equal((await normalizeHook(payload, workspace)).id, secret.id);
    const external = await normalizeHook({ ...payload, tool_input: { file_path: join(workspace, 'link.txt') } }, workspace);
    assert.ok(external.filterReasons.includes('outside_workspace'));
    const redacted = await normalizeHook({ ...payload, tool_input: { file_path: join(workspace, 'safe.txt') }, tool_response: { authorization: 'Bearer sensitive', other: 'password=hidden' } }, workspace);
    assert.ok(!redacted.text.includes('sensitive')); assert.ok(!redacted.text.includes('hidden'));
    const long = await normalizeHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'x'.repeat(30_000) }, workspace);
    assert.equal(long.truncated, true); assert.ok(long.text.endsWith('[TRUNCATED HOST EVENT]'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a single private kernel binds sessions, denies forged scope and drains on exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'banana-host-kernel-'));
  const fixture = fixtureBackend();
  const options = { dataDir: dir, createBackend: async () => fixture.backend, idleGraceMs: 80, drainMs: 200 };
  const kernel = await startKernel(options); assert.ok(kernel);
  let hook: KernelClient | undefined; let mcp: KernelClient | undefined;
  try {
    assert.equal(await startKernel(options), null);
    assert.equal((await stat(join(runtimeDirectory(dir), 'kernel.sock'))).mode & 0o777, 0o600);
    const identity = { workspace: dir, sessionId: 'claude-session', origin: 'hook' as const };
    hook = await KernelClient.connect(dir, identity, process.pid);
    await hook.request('hook', { payload: { hook_event_name: 'SessionStart', session_id: identity.sessionId } });
    mcp = await KernelClient.connect(dir, { ...identity, origin: 'mcp', sessionId: 'unknown-mcp-session' }, process.pid);
    await mcp.request('tool', { tool: 'recall', args: { query: 'fact' } });
    assert.equal(fixture.calls[0]?.identity.sessionId, 'claude-session');
    await assert.rejects(mcp.request('tool', { tool: 'recall', args: { query: 'fact', projectId: 'other' } }), /unauthorized/);
    await assert.rejects(mcp.request('hook', { payload: { hook_event_name: 'UserPromptSubmit', session_id: identity.sessionId, prompt: '/banana-memory:memory pause' } }), /unauthorized/);
    await hook.request('hook', { payload: { hook_event_name: 'UserPromptSubmit', session_id: identity.sessionId, prompt: '/banana-memory:memory pause' } });
    assert.deepEqual(fixture.events.at(-1)?.intent, { action: 'pause' });
    await hook.request('hook', { payload: { hook_event_name: 'SessionEnd', session_id: identity.sessionId } });
    hook.close(); mcp.close();
    await kernel.done;
    assert.equal(fixture.isClosed(), true);
  } finally { hook?.close(); mcp?.close(); await kernel.close(); await rm(dir, { recursive: true, force: true }); await rm(runtimeDirectory(dir), { recursive: true, force: true }); }
});

test('real MCP stdio initializes before backend readiness and exposes five tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'banana-host-mcp-'));
  const fixture = fixtureBackend();
  let ready!: () => void;
  const gate = new Promise<void>(resolve => { ready = resolve; });
  const kernel = await startKernel({ dataDir: dir, createBackend: async () => { await gate; return fixture.backend; } }); assert.ok(kernel);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/cli.ts'), 'mcp'], stderr: 'pipe', env: { ...process.env as Record<string, string>, BANANA_MEMORY_HOME: dir, CLAUDE_PROJECT_DIR: dir } });
  const client = new Client({ name: 'host-contract-test', version: '1' });
  try {
    await client.connect(transport);
    const metadata = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string };
    assert.equal(client.getServerVersion()?.version, metadata.version);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ['recall', 'record', 'feedback', 'inspect', 'manage']);
    // The service is still behind the gate. Protocol initialization/listTools have already completed.
    ready();
    const response = await client.callTool({ name: 'recall', arguments: { query: 'fact' } });
    assert.notEqual(response.isError, true);
    assert.equal(fixture.calls.at(-1)?.identity.workspace, await import('node:fs/promises').then(fs => fs.realpath(dir)));
    const forged = await client.callTool({ name: 'manage', arguments: { user_confirmed: true } });
    assert.equal(forged.isError, true);
  } finally { ready(); await client.close(); await kernel.close(); await rm(dir, { recursive: true, force: true }); await rm(runtimeDirectory(dir), { recursive: true, force: true }); }
});

test('hook timeout fails open without returning stale context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'banana-host-timeout-'));
  const fixture = fixtureBackend();
  fixture.backend.handleHook = async () => { await new Promise(resolve => setTimeout(resolve, 1500)); return { additionalContext: 'late and stale' }; };
  const kernel = await startKernel({ dataDir: dir, createBackend: async () => fixture.backend }); assert.ok(kernel);
  try {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'hook', 'UserPromptSubmit'], { env: { ...process.env, BANANA_MEMORY_HOME: dir, CLAUDE_PROJECT_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'timeout', prompt: 'continue my task' }));
    const status = await new Promise<number | null>(resolve => child.on('exit', resolve));
    assert.equal(status, 0); assert.equal(stdout, ''); assert.ok(Date.now() - started < 1400);
  } finally { await kernel.close(); await rm(dir, { recursive: true, force: true }); await rm(runtimeDirectory(dir), { recursive: true, force: true }); }
});

test('Claude Code 2.1.231 executes plugin hooks and injects context into a local API fixture', { skip: !process.env.BANANA_CLAUDE_SMOKE_PLUGIN }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'banana-claude-smoke-'));
  const fixture = fixtureBackend();
  const marker = 'BANANA_SYNTHETIC_CONTEXT_7f0951';
  fixture.backend.handleHook = async (context, event, intent) => {
    fixture.events.push({ identity: context as HostIdentity, event, intent });
    return { additionalContext: `${marker}\n${intent ? 'intentToken: fixture-token' : 'Synthetic remembered fact.'}` };
  };
  const kernel = await startKernel({ dataDir: join(dir, 'memory'), createBackend: async () => fixture.backend }); assert.ok(kernel);
  let injected = false; let sentTool = false;
  const api = createHttpServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += String(chunk);
    injected ||= input.includes(marker);
    if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":100}'); return; }
    const body = JSON.parse(input || '{}') as { stream?: boolean; tools?: { name: string }[] };
    const toolName = body.tools?.find(tool => tool.name.includes('banana-memory') && tool.name.endsWith('__manage'))?.name;
    const callTool = !!toolName && !sentTool && input.includes(marker);
    if (callTool) sentTool = true;
    const content = callTool ? [{ type: 'tool_use', id: 'tool_fixture', name: toolName, input: { intentToken: 'fixture-token' } }] : [{ type: 'text', text: 'Synthetic host validation complete.' }];
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content, stop_reason: callTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 8 } };
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      const event = (type: string, value: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: callTool ? { type: 'tool_use', id: 'tool_fixture', name: toolName, input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: callTool ? { type: 'input_json_delta', partial_json: '{"intentToken":"fixture-token"}' } : { type: 'text_delta', text: 'Synthetic host validation complete.' } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });
      event('message_stop', { type: 'message_stop' }); response.end();
    } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); }
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  try {
    const address = api.address(); assert.ok(address && typeof address !== 'string');
    const child = spawn('claude', ['-p', '/banana-memory:memory pause', '--plugin-dir', process.env.BANANA_CLAUDE_SMOKE_PLUGIN!, '--output-format', 'json', '--no-session-persistence', '--setting-sources', '', '--tools', '', '--allowedTools', 'mcp__plugin_banana-memory_banana-memory__manage'], {
      cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), BANANA_MEMORY_HOME: join(dir, 'memory'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdout.resume();
    const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
    const code = await new Promise<number | null>(resolve => child.on('exit', resolve)); clearTimeout(timer);
    assert.equal(code, 0, `Claude fixture exit; stderr categories only: ${stderr.includes('error') ? 'error' : 'none'}`);
    assert.ok(fixture.events.some(item => item.event.kind === 'SessionStart'));
    assert.ok(fixture.events.some(item => item.event.kind === 'UserPromptSubmit' && item.intent?.action === 'pause'));
    assert.ok(fixture.events.some(item => item.event.kind === 'Stop'));
    assert.equal(injected, true);
    assert.equal(sentTool, true);
    const manage = fixture.calls.find(item => item.tool === 'manage'); assert.ok(manage);
    assert.equal(manage.args.intentToken, 'fixture-token');
    assert.equal(manage.identity.sessionId, fixture.events.find(item => item.event.kind === 'UserPromptSubmit')?.identity.sessionId);
    assert.equal(fixture.events.find(item => item.event.kind === 'UserPromptSubmit')?.identity.workspace, await import('node:fs/promises').then(fs => fs.realpath(dir)));
  } finally { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); await kernel.close(); await rm(dir, { recursive: true, force: true }); await rm(runtimeDirectory(join(dir, 'memory')), { recursive: true, force: true }); }
});
