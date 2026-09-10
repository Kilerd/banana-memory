import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ResourceDownloader } from '../src/models/download.js';
import { ManagedLocalModels } from '../src/models/index.js';
import type { ModelManifest, Resource } from '../src/models/types.js';

const content = Buffer.from('a-pinned-model-resource');
function resource(): Resource { return { id: 'embedding', repository: 'test/fixture', revision: 'abc', filename: 'fixture.gguf', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), url: 'https://example.test/fixture', license: 'MIT' }; }
async function temporary(t: { after: (fn: () => Promise<unknown>) => void }) { const dir = await mkdtemp(path.join(os.tmpdir(), 'banana-models-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('resources resume a partial file, verify it, then reuse the atomic cache offline', async t => {
  const directory = await temporary(t); const res = resource();
  await writeFile(path.join(directory, res.filename + '.part'), content.subarray(0, 8));
  let requests = 0;
  const downloader = new ResourceDownloader({ directory, resources: [res], reserveBytes: 0, fetch: (async (_url, options) => {
    requests++; assert.equal((options?.headers as Record<string, string>).Range, 'bytes=8-');
    assert.equal(await stat(path.join(directory, res.filename)).then(() => true, () => false), false);
    return new Response(content.subarray(8), { status: 206, headers: { 'Content-Range': `bytes 8-${content.length - 1}/${content.length}` } });
  }) as typeof fetch });
  await Promise.all([downloader.prepare(), downloader.prepare()]);
  assert.deepEqual(await readFile(path.join(directory, res.filename)), content);
  await downloader.prepare(); assert.equal(requests, 1);
  assert.equal(await stat(path.join(directory, res.filename + '.part')).then(() => true, () => false), false);
});

test('a server ignoring Range restarts the partial without appending corruption', async t => {
  const directory = await temporary(t); const res = resource();
  await writeFile(path.join(directory, res.filename + '.part'), content.subarray(0, 8));
  await new ResourceDownloader({ directory, resources: [res], reserveBytes: 0, fetch: (async () => new Response(content)) as typeof fetch }).prepare();
  assert.deepEqual(await readFile(path.join(directory, res.filename)), content);
});

test('checksum failure is persistent, cannot publish partial models, and requires explicit retry', async t => {
  const directory = await temporary(t); const res = resource(); let requests = 0;
  const downloader = new ResourceDownloader({ directory, resources: [res], reserveBytes: 0, fetch: (async () => { requests++; return new Response(requests === 1 ? Buffer.alloc(content.length) : content); }) as typeof fetch });
  await assert.rejects(downloader.prepare(), { code: 'CHECKSUM_MISMATCH' });
  await assert.rejects(downloader.prepare(), { code: 'CHECKSUM_MISMATCH' }); assert.equal(requests, 1);
  assert.equal(await stat(path.join(directory, res.filename)).then(() => true, () => false), false);
  await downloader.prepare(true); assert.equal(requests, 2);
});

test('insufficient disk space is reported before any network download', async t => {
  const directory = await temporary(t); let requests = 0;
  const downloader = new ResourceDownloader({ directory, resources: [resource()], freeBytes: async () => 0, fetch: (async () => { requests++; return new Response(content); }) as typeof fetch });
  await assert.rejects(downloader.prepare(), { code: 'DISK_FULL' }); assert.equal(requests, 0);
});

test('interrupted download remains resumable and does not repeatedly retry on restart', async t => {
  const directory = await temporary(t); const res = resource(); let requests = 0;
  const downloader = new ResourceDownloader({ directory, resources: [res], reserveBytes: 0, fetch: (async () => { requests++; throw new Error('offline'); }) as typeof fetch });
  await assert.rejects(downloader.prepare(), { code: 'DOWNLOAD_FAILED' });
  await assert.rejects(new ResourceDownloader({ directory, resources: [res], reserveBytes: 0, fetch: (async () => { requests++; return new Response(content); }) as typeof fetch }).prepare(), { code: 'DOWNLOAD_FAILED' });
  assert.equal(requests, 1);
});

test('concurrent independent download clients acquire one cache writer', async t => {
  const directory = await temporary(t); let requests = 0;
  const options = { directory, resources: [resource()], reserveBytes: 0, fetch: (async () => { requests++; await new Promise(r => setTimeout(r, 40)); return new Response(content); }) as typeof fetch };
  await Promise.all([new ResourceDownloader(options).prepare(), new ResourceDownloader(options).prepare()]);
  assert.equal(requests, 1);
});

async function localFixture(t: { after: (fn: () => Promise<unknown>) => void }, generationIdleMs = 30) {
  const directory = await temporary(t);
  const res = resource(); await writeFile(path.join(directory, res.filename), content);
  const fakeServer = `#!${process.execPath}\nimport http from 'node:http';\nimport fs from 'node:fs';\nconst port=Number(process.argv[process.argv.indexOf('--port')+1]);\nif(process.argv[process.argv.indexOf('--host')+1]!=='127.0.0.1'||!process.env.LLAMA_API_KEY)process.exit(2);\nhttp.createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+process.env.LLAMA_API_KEY){res.writeHead(401);res.end();return;}let body='';for await(const b of req)body+=b;const data=body?JSON.parse(body):{};let result={status:'ok'};if(req.url==='/apply-template')result={prompt:JSON.stringify(data.messages)};if(req.url==='/tokenize')result={tokens:Array(Math.ceil(data.content.length/3)).fill(1)};if(req.url==='/v1/embeddings'&&fs.existsSync(new URL('./slow',import.meta.url)))await new Promise(r=>setTimeout(r,100));if(req.url==='/v1/embeddings')result={data:[{embedding:[2,...Array(1023).fill(0)]}]};if(req.url==='/v1/chat/completions'&&fs.existsSync(new URL('./crash',import.meta.url)))process.exit(17);if(req.url==='/v1/chat/completions')result={choices:[{message:{content:fs.readFileSync(new URL('./candidates.json',import.meta.url),'utf8')}}]};res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}).listen(port,'127.0.0.1');`;
  await writeFile(path.join(directory, 'server.mjs'), fakeServer, { mode: 0o700 });
  const manifest: ModelManifest = { version: 'fixture', platform: process.platform, arch: process.arch, resources: [{ ...res, id: 'generation' }, res, { ...res, id: 'runtime' }], runtimeExecutable: 'server.mjs', generation: { inputTokens: 4096, outputTokens: 768, contextTokens: 5120 }, embedding: { dimensions: 1024, pooling: 'last', normalization: 'l2', queryInstruction: 'Find project memories' } };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const good = { type: 'fact', text: 'Use pnpm 9, not npm.', sourceIds: ['e1'], evidence: [{ sourceId: 'e1', quote: 'Use pnpm 9, not npm.' }], conditions: [], confidence: 0.99 };
  await writeFile(path.join(directory, 'candidates.json'), JSON.stringify({ candidates: [good, { ...good, text: 'hallucinated' }, { ...good, sourceIds: ['absent'] }] }));
  const models = new ManagedLocalModels({ directory, manifestPath: path.join(directory, 'manifest.json'), generationIdleMs, queryTimeoutMs: 40 });
  t.after(() => models.shutdown());
  return { directory, models, good };
}

test('local model API validates sources, normalizes embeddings and releases processes', async t => {
  const { directory, models, good } = await localFixture(t);
  await assert.rejects(models.embed('question', 'query'), { code: 'MODEL_PREPARING' });
  await models.prepare(); assert.equal(models.status().phase, 'ready');
  const vector = await models.embed('project', 'document'); assert.equal(vector.length, 1024); assert.equal(Math.hypot(...vector), 1);
  assert.deepEqual(await models.extract([{ id: 'e1', text: 'Use pnpm 9, not npm.', role: 'user' }]), [good]);
  await new Promise(r => setTimeout(r, 80)); assert.equal(models.status().generationLoaded, false);
  await writeFile(path.join(directory, 'slow'), '1');
  const started = performance.now();
  await assert.rejects(models.embed('slow question', 'query'), { code: 'MODEL_TIMEOUT' });
  assert.ok(performance.now() - started < 250, 'foreground query must respect its deadline');
  await models.shutdown(); assert.equal(models.status().phase, 'stopped');
  await assert.rejects(models.embed('question', 'query'), { code: 'MODEL_STOPPED' });
});


test('explicit retry recovers degraded generation while the embedding process remains loaded', async t => {
  const { directory, models, good } = await localFixture(t, 60_000);
  await models.prepare();
  assert.equal(models.status().embeddingLoaded, true);
  await writeFile(path.join(directory, 'crash'), '1');
  await assert.rejects(models.extract([{ id: 'e1', text: good.text, role: 'user' }]), { code: 'MODEL_FAILED' });
  for (let i = 0; i < 100 && models.status().phase !== 'degraded'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(models.status().phase, 'degraded');
  assert.equal(models.status().error?.code, 'MODEL_FAILED');
  assert.equal(models.status().embeddingLoaded, true);
  await rm(path.join(directory, 'crash'));
  await models.retry();
  assert.equal(models.status().phase, 'ready');
  assert.equal(models.status().error, undefined);
  assert.deepEqual(await models.extract([{ id: 'e1', text: good.text, role: 'user' }]), [good]);
  assert.equal(models.status().generationLoaded, true);
});
