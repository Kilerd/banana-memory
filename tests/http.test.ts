import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer, WORKSPACE_ROOT_HEADER } from '../src/host/http.js';
import { runtimeDirectory } from '../src/host/ipc.js';
import type { HostIdentity, ServerBackend } from '../src/host/contracts.js';

const execFileAsync = promisify(execFile);

test('foreground HTTP MCP authenticates requests and binds tools to the client root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-http-'));
  const workspace = await mkdtemp(join(tmpdir(), 'banana-http-workspace-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(runtimeDirectory(directory), { recursive: true, force: true });
  });
  const identities: HostIdentity[] = [];
  const calls: Array<{ tool: string; args: Record<string, unknown>; context: unknown }> = [];
  const backend: ServerBackend = {
    async bind(identity) { identities.push(identity); return identity; },
    async handleHook() { throw new Error('unexpected_hook'); },
    async call(context, tool, args) { calls.push({ context, tool, args }); return { tool, args }; },
    async dashboard() { return { totals: { memories: 2 }, memories: [{ id: 'memory-one' }] }; },
    async retryModels() { return { phase: 'ready' }; },
    async close() {},
  };
  const server = await startHttpServer({ dataDir: directory, port: 0, token: 'test-secret', createBackend: async () => backend });
  t.after(() => server.close());

  assert.deepEqual(await fetch(server.url.replace('/mcp', '/health')).then(response => response.json()), { status: 'ok' });
  const page = await fetch(server.url.replace('/mcp', '/'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const pageHtml = await page.text();
  assert.match(pageHtml, /记忆如何留下/);
  assert.match(pageHtml, /生成模型/);
  assert.equal((await fetch(server.url.replace('/mcp', '/api/dashboard'))).status, 401);
  assert.deepEqual(await fetch(server.url.replace('/mcp', '/api/dashboard'), { headers: { authorization: 'Bearer test-secret' } }).then(response => response.json()), { totals: { memories: 2 }, memories: [{ id: 'memory-one' }] });
  assert.equal((await fetch(server.url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(server.url, {
    method: 'POST', headers: { authorization: 'Bearer test-secret', origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })).status, 403);

  const client = new Client({ name: 'banana-http-test', version: '1.0.0' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspace).href, name: 'fixture' }] }));
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: 'Bearer test-secret' } } });
  await client.connect(transport);
  assert.match(client.getInstructions() ?? '', /call recall/);
  assert.match(client.getInstructions() ?? '', /call record before the final response/);
  const result = await client.callTool({ name: 'record', arguments: { text: 'The API uses port 7443.', projectName: 'Control Plane', taskId: 'task-1' } });
  assert.equal(result.isError, undefined);
  assert.equal(identities.length, 1);
  assert.deepEqual(identities[0], { workspace: await realpath(workspace), projectName: 'fixture', sessionId: transport.sessionId, origin: 'mcp', includeCandidates: true });
  assert.equal(calls[0]?.tool, 'record');
  assert.deepEqual(calls[0]?.args, { text: 'The API uses port 7443.', projectName: 'Control Plane', taskId: 'task-1' });
  await client.close();
});

test('Codex workspace headers keep rootless MCP sessions on the same trusted project', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-http-codex-'));
  const workspace = await mkdtemp(join(tmpdir(), 'banana-http-codex-workspace-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(runtimeDirectory(directory), { recursive: true, force: true });
  });
  const identities: HostIdentity[] = [];
  const backend: ServerBackend = {
    async bind(identity) { identities.push(identity); return identity; },
    async handleHook() { throw new Error('unexpected_hook'); },
    async call(context) { return context; },
    async close() {},
  };
  const server = await startHttpServer({ dataDir: directory, port: 0, token: 'test-secret', createBackend: async () => backend });
  t.after(() => server.close());

  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `codex-${index}`, version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: {
      authorization: 'Bearer test-secret',
      [WORKSPACE_ROOT_HEADER]: pathToFileURL(workspace).href,
    } } });
    await client.connect(transport);
    const result = await client.callTool({ name: 'inspect', arguments: {} });
    assert.equal(result.isError, undefined);
    await client.close();
  }

  assert.equal(identities.length, 2);
  assert.deepEqual(identities.map(identity => identity.workspace), [await realpath(workspace), await realpath(workspace)]);
  assert.notEqual(identities[0]?.sessionId, identities[1]?.sessionId);
  assert.equal(identities.every(identity => identity.scopeReason === undefined), true);
});

test('the Codex header helper emits authentication and a canonical file root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-http-helper-'));
  const workspace = await mkdtemp(join(tmpdir(), 'banana-http-helper-workspace-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(runtimeDirectory(directory), { recursive: true, force: true });
  });
  const backend: ServerBackend = {
    async bind(identity) { return identity; },
    async handleHook() { throw new Error('unexpected_hook'); },
    async call() { throw new Error('unexpected_call'); },
    async close() {},
  };
  const server = await startHttpServer({ dataDir: directory, port: 0, createBackend: async () => backend });
  t.after(() => server.close());
  const repository = process.cwd();
  const cli = join(repository, 'src/cli.ts');
  const { stdout, stderr } = await execFileAsync(join(repository, 'node_modules/.bin/tsx'), [cli, 'codex-headers', pathToFileURL(directory).href], {
    cwd: workspace,
  });
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), {
    Authorization: `Bearer ${server.token}`,
    'X-Banana-Memory-Root': pathToFileURL(await realpath(workspace)).href,
  });
});

test('a repeated start reports the healthy foreground server and exits successfully', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-http-repeat-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(runtimeDirectory(directory), { recursive: true, force: true });
  });
  const backend: ServerBackend = {
    async bind(identity) { return identity; },
    async handleHook() { throw new Error('unexpected_hook'); },
    async call() { throw new Error('unexpected_call'); },
    async close() {},
  };
  const server = await startHttpServer({ dataDir: directory, port: 0, createBackend: async () => backend });
  t.after(() => server.close());

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--import', 'tsx', join(process.cwd(), 'src/cli.ts'), 'start', '--port', String(server.port),
  ], { env: { ...process.env, BANANA_MEMORY_HOME: directory } });

  assert.equal(stderr, '');
  assert.match(stdout, /^Banana Memory is already running\./);
  assert.match(stdout, new RegExp(`UI:  http://127\\.0\\.0\\.1:${server.port}/#token=[a-f0-9]{64}`));
  assert.match(stdout, new RegExp(`MCP: http://127\\.0\\.0\\.1:${server.port}/mcp`));
  assert.ok(stdout.includes(`http_headers_helper = "npx -y banana-memory@latest codex-headers '${pathToFileURL(directory).href}'"`));
  assert.match(stdout, /claude mcp add --transport http --scope user/);
});
