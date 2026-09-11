import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer } from '../src/host/http.js';
import { runtimeDirectory } from '../src/host/ipc.js';
import type { HostIdentity, ServerBackend } from '../src/host/contracts.js';

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
    async retryModels() { return { phase: 'ready' }; },
    async close() {},
  };
  const server = await startHttpServer({ dataDir: directory, port: 0, token: 'test-secret', createBackend: async () => backend });
  t.after(() => server.close());

  assert.deepEqual(await fetch(server.url.replace('/mcp', '/health')).then(response => response.json()), { status: 'ok' });
  assert.equal((await fetch(server.url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(server.url, {
    method: 'POST', headers: { authorization: 'Bearer test-secret', origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })).status, 403);

  const client = new Client({ name: 'banana-http-test', version: '1.0.0' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspace).href, name: 'fixture' }] }));
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: 'Bearer test-secret' } } });
  await client.connect(transport);
  const result = await client.callTool({ name: 'record', arguments: { text: 'The API uses port 7443.', taskId: 'task-1' } });
  assert.equal(result.isError, undefined);
  assert.equal(identities.length, 1);
  assert.deepEqual(identities[0], { workspace: await realpath(workspace), sessionId: transport.sessionId, origin: 'mcp', includeCandidates: true });
  assert.equal(calls[0]?.tool, 'record');
  assert.deepEqual(calls[0]?.args, { text: 'The API uses port 7443.', taskId: 'task-1' });
  await client.close();
});
