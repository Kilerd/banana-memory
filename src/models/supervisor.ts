import { spawn, type ChildProcess } from 'node:child_process';

// The supervisor owns exactly one child. A pipe from the kernel remains open for
// its lifetime; even SIGKILL closes that pipe, unlike ordinary signal handlers.
const SUPERVISOR = String.raw`
const { spawn } = require('node:child_process');
const [executable, args] = JSON.parse(process.argv[1]);
const model = spawn(executable, args, { stdio: 'ignore', env: process.env });
let stopping = false;
let forceTimer;
let input = '';
const terminate = (force = false) => {
  if (model.exitCode !== null || model.signalCode) return;
  if (force) { model.kill('SIGKILL'); return; }
  if (stopping) return;
  stopping = true;
  model.kill('SIGTERM');
  forceTimer = setTimeout(() => model.kill('SIGKILL'), 5000);
};
model.once('error', () => process.exit(1));
model.once('exit', (code, signal) => {
  clearTimeout(forceTimer);
  process.exit(code === null ? (signal ? 1 : 0) : code);
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 1024) { terminate(); input = ''; return; }
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const command = input.slice(0, newline); input = input.slice(newline + 1);
    if (command === 'SIGKILL') terminate(true);
    else if (command === 'SIGTERM') terminate();
  }
});
process.stdin.once('end', () => terminate());
process.stdin.once('error', () => terminate());
process.stdin.resume();
process.once('SIGTERM', () => terminate());
process.once('SIGINT', () => terminate());
`;

/**
 * Run a model without leaving it orphaned if its kernel is killed.
 * `pid` names the supervisor. TERM/KILL on the returned handle are relayed to
 * its owned model, and the handle exits only after that model exits.
 */
export function launchSupervised(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  const supervisor = spawn(process.execPath, ['-e', SUPERVISOR, JSON.stringify([executable, args])], {
    stdio: ['pipe', 'ignore', 'ignore'], env,
  });
  supervisor.stdin?.on('error', () => {});
  const signalSupervisor = supervisor.kill.bind(supervisor);
  supervisor.kill = (signal: NodeJS.Signals | number = 'SIGTERM'): boolean => {
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') return signalSupervisor(signal);
    if (!supervisor.stdin || supervisor.stdin.destroyed || supervisor.exitCode !== null || supervisor.signalCode) return false;
    // Do not SIGKILL the watchdog: it must remain alive to reap the model.
    try { supervisor.stdin.write(`${signal}\n`); return true; } catch { return false; }
  };
  return supervisor;
}
