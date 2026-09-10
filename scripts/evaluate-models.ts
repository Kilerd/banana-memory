import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ManagedLocalModels, type MemoryCandidate, type ModelEvent } from '../src/models/index.js';
const exec = promisify(execFile);
const directory = path.resolve(process.env.BANANA_MODEL_DIR ?? '.runtime/models');
const output = path.resolve(process.env.BANANA_MODEL_REPORT ?? 'docs/model-evaluation.json');
const examples: Array<{ event: ModelEvent; required: string[]; types: string[]; query: string }> = [
  { event: { id: 'zh-packages', role: 'user', text: '这个项目使用 pnpm 9，不使用 npm。只有 legacy 子目录仍然使用 yarn 1。' }, required: ['pnpm 9', '不使用 npm', 'legacy', 'yarn 1'], types: ['fact'], query: '安装项目依赖应该用什么包管理器，老目录有什么例外？' },
  { event: { id: 'en-node', role: 'user', text: 'The API requires Node.js 22. Node.js 20 is unsupported because its runtime APIs differ.' }, required: ['Node.js 22', 'Node.js 20', 'unsupported'], types: ['fact'], query: 'Which JavaScript runtime version does the backend require?' },
  { event: { id: 'zh-preference', role: 'user', text: '我偏好用中文解释代码变更，但 commit message 保持英文。' }, required: ['中文', 'commit message', '英文'], types: ['preference'], query: '我希望代码修改说明用哪种语言？' },
  { event: { id: 'en-preference', role: 'user', text: 'I prefer integration tests for storage changes, except pure documentation edits do not need tests.' }, required: ['integration tests', 'except', 'documentation'], types: ['preference'], query: 'What testing style do I prefer when changing persistence?' },
  { event: { id: 'error', role: 'tool', text: 'PostgreSQL 16 connection failed with ECONNREFUSED at 127.0.0.1:5432. No migration was applied.' }, required: ['PostgreSQL 16', 'ECONNREFUSED', 'No migration'], types: ['episode', 'fact'], query: '数据库连接被拒绝时发生了什么？' },
  { event: { id: 'conditional', role: 'user', text: '在 macOS 14 上，禁用文件监视可避免 EMFILE；Linux 容器里不要禁用监视。' }, required: ['macOS 14', 'EMFILE', 'Linux', '不要'], types: ['fact', 'episode'], query: '打开文件过多的错误在苹果系统上如何处理，有什么限制？' },
  { event: { id: 'cache', role: 'user', text: 'Redis 缓存有效期是 300 秒。权限变更必须立即清缓存，不能等待自然过期。' }, required: ['300 秒', '立即', '不能'], types: ['fact'], query: '访问权限变化后缓存多久才失效？' },
  { event: { id: 'retry', role: 'user', text: 'Payment writes are not automatically retried. A retry requires the original idempotency key.' }, required: ['not automatically retried', 'original idempotency key'], types: ['fact'], query: 'Can we retry failed payment requests without duplicating charges?' },
  { event: { id: 'result', role: 'user', text: '本次任务已由我验收：分页修复通过 12 个集成用例，未验证 Safari 17。' }, required: ['12', '未验证', 'Safari 17'], types: ['episode', 'fact'], query: '上次分页修复验证了哪些范围？' },
  { event: { id: 'quoted', role: 'user', text: '第三方 README 引用：“我喜欢把日志发到云端。”这不是我的偏好，也不是项目要求。' }, required: ['第三方', '不是我的偏好', '不是项目要求'], types: ['fact', 'episode'], query: '第三方文档里的日志上传要求代表我的偏好吗？' },
  { event: { id: 'env', role: 'user', text: 'The build target is macOS arm64 only. Windows and Intel Macs have not been validated.' }, required: ['macOS arm64 only', 'Windows', 'Intel Macs', 'not been validated'], types: ['fact'], query: 'Can I install this tool on an Intel Mac?' },
  { event: { id: 'secret', role: 'user', text: '测试使用 synthetic_test_token，不使用真实生产密钥；测试日志不得包含 token 正文。' }, required: ['synthetic_test_token', '不使用真实', '不得'], types: ['fact'], query: '测试凭据与日志应该遵循什么约束？' },
];
const distractors = ['The design system uses an eight-pixel spacing grid.', '公司午餐时间是中午十二点。', 'The image carousel displays four photographs.', '开发用的椅子是蓝色的。'];
const rawGenerations: unknown[] = [];
const originalFetch = globalThis.fetch;
// Capture only this script's fixed synthetic fixtures for reproducible model QA.
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (String(args[0]).endsWith('/v1/chat/completions')) rawGenerations.push(await response.clone().json());
  return response;
};
const models = new ManagedLocalModels({ directory, manifestPath: path.resolve('models/manifest.json'), queryTimeoutMs: 1000 });
let peakChildRssKiB = 0;
let sampling = false;
const sample = setInterval(() => {
  if (sampling) return; sampling = true;
  void exec('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm=']).then(({ stdout }) => {
    const processes = stdout.split('\n').flatMap(line => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return m ? [{ pid: Number(m[1]), parent: Number(m[2]), rss: Number(m[3]), name: m[4]! }] : [];
    });
    const descendants = new Set([process.pid]);
    for (let previous = -1; previous !== descendants.size;) {
      previous = descendants.size;
      for (const child of processes) if (descendants.has(child.parent)) descendants.add(child.pid);
    }
    const rss = processes.reduce((sum, child) => sum + (descendants.has(child.pid) && child.name.includes('llama-server') ? child.rss : 0), 0);
    peakChildRssKiB = Math.max(peakChildRssKiB, rss);
  }).catch(() => undefined).finally(() => { sampling = false; });
}, 250); sample.unref();
const extraction: Array<{ id: string; elapsedMs: number; candidates: MemoryCandidate[]; passedFields: number; totalFields: number; referenceValid: boolean }> = [];
try {
  const start = performance.now(); await models.prepare(); const prepareMs = performance.now() - start;
  for (const example of examples) {
    const start = performance.now(); const candidates = await models.extract([example.event]);
    const elapsedMs = performance.now() - start;
    const selected = candidates.find(c => c.sourceIds.includes(example.event.id));
    const passedFields = selected ? example.required.filter(fragment => selected.text.includes(fragment)).length + Number(example.types.includes(selected.type)) : 0;
    const referenceValid = candidates.every(c => c.sourceIds.every(id => id === example.event.id) && c.evidence.every(e => e.sourceId === example.event.id && example.event.text.includes(e.quote)));
    extraction.push({ id: example.event.id, elapsedMs, candidates, passedFields, totalFields: example.required.length + 1, referenceValid });
    console.error(`extraction ${example.event.id}: ${passedFields}/${example.required.length + 1} fields; ${Math.round(elapsedMs)} ms`);
  }
  const corpus = [...examples.map(e => e.event.text), ...distractors];
  const vectors: number[][] = [];
  for (const text of corpus) vectors.push(await models.embed(text, 'document'));
  const retrieval: Array<{ id: string; elapsedMs: number; rank: number }> = [];
  for (let round = 0; round < 2; round++) for (let i = 0; i < examples.length; i++) {
    const start = performance.now(); const vector = await models.embed(examples[i]!.query, 'query'); const elapsedMs = performance.now() - start;
    const ranking = vectors.map((v, index) => ({ index, score: v.reduce((sum, value, dim) => sum + value * vector[dim]!, 0) })).sort((a, b) => b.score - a.score);
    retrieval.push({ id: `${examples[i]!.event.id}-${round}`, elapsedMs, rank: ranking.findIndex(r => r.index === i) + 1 });
  }
  const fieldCorrect = extraction.reduce((sum, result) => sum + result.passedFields, 0); const fieldTotal = extraction.reduce((sum, result) => sum + result.totalFields, 0);
  const sourceChecks = extraction.reduce((sum, result) => sum + result.candidates.reduce((n, c) => n + c.evidence.length, 0), 0);
  const sorted = retrieval.map(r => r.elapsedMs).sort((a, b) => a - b); const recall6 = retrieval.filter(r => r.rank <= 6).length;
  const report = { recordedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() }, manifest: models.status().modelVersion, corpusSize: corpus.length, queryCount: retrieval.length, extractionSampleCount: examples.length, prepareIncludingHashVerificationAndEmbeddingColdLoadMs: prepareMs, firstGenerationIncludingColdLoadMs: extraction[0]!.elapsedMs, warmQueryEmbeddingP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], peakInferenceChildrenRssKiB: peakChildRssKiB, fields: { correct: fieldCorrect, total: fieldTotal, accuracy: fieldCorrect / fieldTotal }, references: { valid: extraction.every(e => e.referenceValid), count: sourceChecks }, retrieval: { recallAt6Correct: recall6, total: retrieval.length, recallAt6: recall6 / retrieval.length, recallAt1Correct: retrieval.filter(r => r.rank === 1).length }, extraction, rawGenerations, queries: retrieval, limitations: ['A fixed 12-event / 24-query M0 sample, not the 40-task / 160-checkpoint release evaluation.', 'Field accuracy measures the public extraction adapter after conservative source-context preservation, not unconstrained model summarization.', 'Warm timings include only the model embedding API; they are not end-to-end hook or 5,000-memory retrieval measurements.', 'The available Mac has its reported physical RAM; this is not evidence for a 16 GB baseline.', 'No live Claude Code workload was run alongside these samples.', 'Preparation and first generation include cold model loading; subsequent extraction timings are warm.'] };
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: output, fields: report.fields, references: report.references, retrieval: report.retrieval, warmQueryEmbeddingP95Ms: report.warmQueryEmbeddingP95Ms, peakInferenceChildrenRssKiB: peakChildRssKiB }));
  if (fieldCorrect / fieldTotal < 0.95 || !report.references.valid || recall6 / retrieval.length < 0.9) process.exitCode = 1;
} finally { clearInterval(sample); globalThis.fetch = originalFetch; await models.shutdown(); }
