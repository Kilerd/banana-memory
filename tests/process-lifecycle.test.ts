import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchSupervised } from '../src/models/supervisor.js';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(condition: () => Promise<boolean> | boolean, timeout = 8000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Owned process did not reach the expected lifecycle state before the deadline');
}

test('kernel SIGKILL closes the supervision pipe and reaps a stubborn model within five seconds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'banana-supervisor-'));
  const pidFile = join(dir, 'owned-model.pid');
  const moduleUrl = new URL('../src/models/supervisor.ts', import.meta.url).href;
  const modelCode = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const parentCode = `import { launchSupervised } from ${JSON.stringify(moduleUrl)}; const child = launchSupervised(process.execPath, ['-e', ${JSON.stringify(modelCode)}, ${JSON.stringify(pidFile)}], { PATH: process.env.PATH }); process.stdout.write(String(child.pid) + '\\n'); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', parentCode], { stdio: ['ignore', 'pipe', 'ignore'] });
  let supervisorPid = 0; let modelPid = 0;
  parent.stdout.setEncoding('utf8'); parent.stdout.on('data', data => { supervisorPid = Number.parseInt(String(data), 10); });
  try {
    await until(async () => { modelPid = await readFile(pidFile, 'utf8').then(Number, () => 0); return modelPid > 0 && supervisorPid > 0; });
    assert.equal(alive(modelPid), true);
    const parentExit = new Promise<void>(resolve => parent.once('exit', () => resolve()));
    parent.kill('SIGKILL'); await parentExit;
    const started = Date.now();
    await until(() => !alive(modelPid), 7500);
    assert.ok(Date.now() - started >= 4500, 'The stubborn child should receive the graceful shutdown window');
    await until(() => !alive(supervisorPid), 2000);
  } finally {
    parent.kill('SIGKILL');
    // These PIDs are produced only by this test's own direct descendants.
    for (const pid of [modelPid, supervisorPid]) if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
});

test('normal TERM followed by KILL targets the model while the supervisor remains to reap it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'banana-supervisor-signal-'));
  const pidFile = join(dir, 'owned-model.pid');
  const model = launchSupervised(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`, pidFile], { PATH: process.env.PATH });
  let modelPid = 0;
  try {
    await until(async () => { modelPid = await readFile(pidFile, 'utf8').then(Number, () => 0); return modelPid > 0; });
    const exited = new Promise<void>(resolve => model.once('exit', () => resolve()));
    assert.equal(model.kill('SIGTERM'), true);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(model.kill('SIGKILL'), true);
    await exited;
    assert.equal(alive(modelPid), false);
  } finally { model.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('supervision preserves an ordinary model exit code', async () => {
  const model = launchSupervised(process.execPath, ['-e', 'process.exit(7)'], { PATH: process.env.PATH });
  const code = await new Promise<number | null>(resolve => model.once('exit', resolve));
  assert.equal(code, 7);
});
