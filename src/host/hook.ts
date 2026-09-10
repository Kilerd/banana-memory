import { resolveWorkspace } from './adapter.js';
import type { HookResult } from './contracts.js';
import { ensureKernel, type KernelClient } from './ipc.js';
import { safeErrorCode } from './errors.js';

export async function runHook(dataDir: string, cliPath: string, expectedKind?: string): Promise<void> {
  let client: KernelClient | undefined;
  // The host timeout is 1 second; exit before it, even when stdin, DB or model is unavailable.
  const hardDeadline = setTimeout(() => { client?.close(); process.stderr.write('banana-memory: hook_timeout\n'); process.exit(0); }, 900);
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 1_000_000) throw new Error('host_input_limit');
    }
    const payload = JSON.parse(input) as Record<string, unknown>;
    if (expectedKind !== payload.hook_event_name || typeof payload.session_id !== 'string') throw new Error('invalid_host_event');
    const workspace = await resolveWorkspace(process.env.CLAUDE_PROJECT_DIR);
    client = await ensureKernel(dataDir, cliPath, { ...workspace, sessionId: payload.session_id, origin: 'hook' }, process.ppid, 750);
    const output = await client.request('hook', { payload }, 800) as HookResult;
    if (output.additionalContext && ['SessionStart', 'UserPromptSubmit'].includes(String(payload.hook_event_name))) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: output.additionalContext } }) + '\n');
    }
  } catch (error) {
    const code = safeErrorCode(error, 'hook_unavailable');
    process.stderr.write(`banana-memory: ${code}\n`);
  } finally { clearTimeout(hardDeadline); client?.close(); }
}
