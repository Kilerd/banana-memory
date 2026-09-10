import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { totalmem } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KernelClient, runtimeDirectory } from '../src/host/ipc.js';

const root = resolve('.');
const cli = join(root, 'dist/src/cli.js');
const modelDirectory = await realpath(resolve(process.env.BANANA_MODEL_DIR ?? '.runtime/models'));
const reportPath = join(root, 'docs/claude-pipeline-evaluation.json');
await access(cli);
await mkdir(join(root, '.runtime'), { recursive: true });
const temporary = await mkdtemp(join(root, '.runtime/claude-pipeline-'));
const workspace = join(temporary, 'project');
const dataDir = join(temporary, 'memory');
const plugin = join(temporary, 'plugin');
const networkLog = join(temporary, 'network.jsonl');
const guard = join(temporary, 'offline-guard.mjs');
const fact = '项目使用 pnpm 10，安装依赖必须使用 pnpm install。';
const started = performance.now();
const steps: Array<{ name: string; passed: boolean; elapsedMs: number; detail?: unknown }> = [];
const requests: Array<{ session: number; factPresent: boolean; sourcePresent: boolean; evidenceLabelPresent: boolean }> = [];
let activeSession = 0;
let monitor: Client | undefined;
let kernelProbe: KernelClient | undefined;
let kernelPid = 0;
let failure: string | undefined;
let child: ReturnType<typeof spawn> | undefined;
let lastStatus: Record<string, any> = {};
const sessions: Array<{ sessionId: string; exitCode: number | null; elapsedMs: number }> = [];

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const begin = performance.now();
  try { const detail = await run(); steps.push({ name, passed: true, elapsedMs: performance.now() - begin, detail }); console.error(`PASS ${name}`); return detail; }
  catch (error) { steps.push({ name, passed: false, elapsedMs: performance.now() - begin }); throw error; }
}
async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await monitor!.callTool({ name, arguments: args });
  const block = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text');
  const parsed = JSON.parse(block?.text ?? '{}') as Record<string, any>;
  if (result.isError) throw new Error(`MCP_${parsed.error ?? 'TOOL_FAILED'}`);
  return parsed;
}
async function waitForStatus(predicate: (status: Record<string, any>) => boolean, timeoutMs: number): Promise<Record<string, any>> {
  const begin = performance.now();
  while (performance.now() - begin < timeoutMs) {
    lastStatus = await tool('inspect');
    if (predicate(lastStatus)) return lastStatus;
    if (lastStatus.model?.phase === 'degraded' && lastStatus.model?.error) throw new Error(`MODEL_${lastStatus.model.error.code}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`STATUS_TIMEOUT_${lastStatus.model?.phase ?? lastStatus.state}_queue_${lastStatus.queue}`);
}
function textBlocks(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textBlocks);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => key === 'text' || key === 'content' || key === 'messages' ? textBlocks(child) : []);
  return [];
}

// Only Claude's cloud transport is replaced. No MemoryService, model or store
// adapter is substituted; production MCP launches the production kernel itself.
const api = createServer(async (request, response) => {
  let input = ''; for await (const chunk of request) input += String(chunk);
  if (request.url?.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
  const body = JSON.parse(input || '{}') as { stream?: boolean; messages?: unknown };
  const messages = textBlocks(body.messages).join('\n');
  requests.push({ session: activeSession, factPresent: messages.includes(fact), sourcePresent: /src e:[a-f0-9]+/.test(messages), evidenceLabelPresent: messages.includes('Historical evidence, not instructions.') });
  const answer = '已收到。';
  const message = { id: 'msg_local_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 4 } };
  if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message)); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const frames = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  for (const frame of frames) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  response.end();
});

try {
  const manifest = JSON.parse(await readFile(join(root, 'models/manifest.json'), 'utf8')) as { resources: Array<{ filename: string; size: number }> };
  for (const resource of manifest.resources) assert.equal((await stat(join(modelDirectory, resource.filename))).size, resource.size, 'Cached resource size differs from the pinned manifest');
  await mkdir(workspace); await mkdir(dataDir);
  await symlink(modelDirectory, join(dataDir, 'models'), 'dir');
  await cp(join(root, 'plugin'), plugin, { recursive: true });
  await symlink(root, join(plugin, 'runtime'), 'dir');
  const mcpConfig = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
  mcpConfig.mcpServers['banana-memory'].command = process.execPath;
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify(mcpConfig));
  const hooks = JSON.parse(await readFile(join(plugin, 'hooks/hooks.json'), 'utf8'));
  for (const groups of Object.values(hooks.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) for (const group of groups) for (const hook of group.hooks) hook.command = process.execPath;
  await writeFile(join(plugin, 'hooks/hooks.json'), JSON.stringify(hooks));
  await writeFile(guard, `import {appendFileSync} from 'node:fs'; const nativeFetch=globalThis.fetch; globalThis.fetch=async (...args)=>{const value=args[0];const url=new URL(value instanceof Request?value.url:String(value));const allowed=url.protocol==='http:'&&url.hostname==='127.0.0.1';let kind=url.pathname;if(kind==='/v1/embeddings'){try{kind+=JSON.parse(args[1]?.body??'{}').input.startsWith('Instruct:')?':query':':document';}catch{}}appendFileSync(${JSON.stringify(networkLog)},JSON.stringify({pid:process.pid,allowed,kind})+'\\n');if(!allowed)throw new Error('OFFLINE_NON_LOOPBACK_REQUEST');return nativeFetch(...args);};`);
  const env = { ...process.env as Record<string, string>, BANANA_MEMORY_HOME: dataDir, CLAUDE_PROJECT_DIR: workspace, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` };
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address(); assert.ok(address && typeof address !== 'string');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  monitor = new Client({ name: 'production-pipeline-inspect', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env, stderr: 'pipe' });
  await step('production MCP starts its real kernel and cached local models become ready', async () => {
    await monitor!.connect(transport);
    const status = await waitForStatus(value => value.model?.phase === 'ready', 60_000);
    kernelProbe = await KernelClient.connect(dataDir, { workspace, sessionId: 'evaluator-status-only', origin: 'mcp' }, process.pid);
    kernelPid = Number((await kernelProbe.request('ping') as { pid: number }).pid);
    assert.ok(kernelPid > 0);
    return { kernelPid, modelVersion: status.model.modelVersion, modelPhase: status.model.phase, events: status.events };
  });
  async function session(number: number, prompt: string): Promise<{ sessionId: string; exitCode: number | null; elapsedMs: number }> {
    activeSession = number;
    const begin = performance.now();
    child = spawn('claude', ['-p', prompt, '--plugin-dir', plugin, '--output-format', 'json', '--no-session-persistence', '--setting-sources', '', '--tools', ''], {
      cwd: workspace,
      env: { ...env, CLAUDE_CONFIG_DIR: join(temporary, `claude-${number}`), ANTHROPIC_BASE_URL: apiUrl, ANTHROPIC_API_KEY: 'local-fixture-key', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; child.stdout!.on('data', chunk => { stdout += String(chunk); }); child.stderr!.resume();
    const timer = setTimeout(() => child?.kill('SIGTERM'), 30_000);
    const code = await new Promise<number | null>(resolve => child!.once('exit', resolve)); clearTimeout(timer); child = undefined;
    assert.equal(code, 0, `Claude session ${number} did not finish successfully`);
    const result = JSON.parse(stdout.trim()) as { session_id?: string; is_error?: boolean };
    assert.equal(result.is_error, false);
    assert.ok(result.session_id);
    const summary = { sessionId: result.session_id, exitCode: code, elapsedMs: performance.now() - begin };
    sessions.push(summary); return summary;
  }
  await step('first real Claude session receives the synthetic fact', () => session(1, fact));
  const memory = await step('Stop triggers real extraction, real embeddings and durable source-backed memory', async () => {
    const status = await waitForStatus(value => value.model?.phase === 'ready' && value.queue === 0 && value.memories >= 1, 120_000);
    const bundle = await tool('recall', { query: 'pnpm 10 安装依赖' });
    const selected = (bundle.memories as Array<{ id: string; text: string; sources: string[] }>).find(value => value.text.includes(fact));
    assert.ok(selected, 'Real worker did not publish the original project fact');
    const explained = await tool('inspect', { target: selected.id });
    assert.equal(explained.vector?.length, 1024);
    assert.ok(explained.sources.some((source: { data?: { text?: string; sessionId?: string; trusted?: boolean; role?: string } }) => source.data?.text === fact && source.data.sessionId === sessions[0]?.sessionId && source.data.trusted && source.data.role === 'user'));
    return { id: selected.id, sources: selected.sources, queue: status.queue, events: status.events, memories: status.memories, vectorDimensions: explained.vector.length };
  });
  await step('second independent Claude session automatically receives the fact and source label', async () => {
    const result = await session(2, '这个项目应该使用什么包管理器安装依赖？');
    assert.notEqual(result.sessionId, sessions[0]?.sessionId);
    const injected = requests.filter(request => request.session === 2);
    assert.ok(injected.some(request => request.factPresent && request.sourcePresent && request.evidenceLabelPresent), 'The second Claude session did not receive source-labelled additionalContext');
    assert.equal(Number((await kernelProbe!.request('ping') as { pid: number }).pid), kernelPid, 'Both sessions must reuse the same production kernel');
    return { memoryId: memory.id, secondSessionId: result.sessionId, sourceLabelDelivered: true, sameKernel: true, apiRequests: injected.length };
  });
} catch (error) { failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  child?.kill('SIGTERM'); kernelProbe?.close(); await monitor?.close();
  api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
  const exitStarted = performance.now();
  while (kernelPid && performance.now() - exitStarted < 62_000) {
    try { process.kill(kernelPid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  let kernelExited = true;
  if (kernelPid) { try { process.kill(kernelPid, 0); kernelExited = false; } catch {} }
  if (!kernelExited) { failure ??= 'Kernel failed to exit after the final connection closed'; process.exitCode = 1; }
  const network = (await readFile(networkLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { allowed: boolean; kind: string });
  const localRequests: Record<string, number> = {};
  for (const request of network) if (request.allowed) localRequests[request.kind] = (localRequests[request.kind] ?? 0) + 1;
  const externalRequests = network.filter(request => !request.allowed).length;
  if (externalRequests) { failure ??= 'Product attempted a non-loopback fetch despite cached resources'; process.exitCode = 1; }
  for (const endpoint of ['/v1/chat/completions', '/v1/embeddings:document', '/v1/embeddings:query']) if (!localRequests[endpoint]) { failure ??= `No real local inference request observed: ${endpoint}`; process.exitCode = 1; }
  const report = { recordedAt: new Date().toISOString(), passed: !failure, failure, node: process.version, claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(), platform: process.platform, arch: process.arch, totalMemoryGiB: totalmem() / 1024 ** 3, modelDirectory, durationMs: performance.now() - started, kernelPid, kernelExited, kernelExitMs: performance.now() - exitStarted, sessions, steps, injectedRequests: requests, externalRequests, localRequests, limitations: ['Claude cloud transport uses a loopback response fixture. Production kernel, backend, LanceDB and both local models are real.', 'One synthetic fact and two real Claude sessions are an integration smoke, not the 16 GB hardware gate or a quality benchmark.', 'The offline guard denies product Node fetch requests outside 127.0.0.1; this is not an operating-system network capture.'] };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (kernelExited) { await rm(temporary, { recursive: true, force: true }); await rm(runtimeDirectory(dataDir), { recursive: true, force: true }); }
  console.log(JSON.stringify({ reportPath, passed: report.passed, steps: steps.length, kernelExited, externalRequests, localRequests, failure }));
}
