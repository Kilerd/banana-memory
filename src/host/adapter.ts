import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ExplicitIntent, HookName, NormalizedEvent } from './contracts.js';
import { normalizeRuntimeName, type RuntimeName } from '../runtime-names.js';

export const HOOK_NAMES: readonly HookName[] = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'];
const MAX_TEXT = 24_000;
const SECRET_FIELD = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const CREDENTIAL_PATH = /(?:^|[\s/'"\\])(?:\.env(?:\.[\w.-]+)?|\.ssh|\.aws|\.netrc|\.npmrc|credentials(?:\.json)?|id_rsa|id_ed25519)(?:$|[\s/'"\\])|\.(?:pem|p12|pfx|key)(?:$|[\s'"\\])/i;

export function parseExplicitIntent(payload: Record<string, unknown>): ExplicitIntent | undefined {
  if (payload.hook_event_name !== 'UserPromptSubmit' || payload.agent_id || payload.agent_type || typeof payload.prompt !== 'string') return;
  if (/[\r\n]/.test(payload.prompt)) return;
  // Anchored grammar: quotes, fences, extra lines, paraphrases and tool output never grant authority.
  const command = /^\/banana-memory:memory (pause|resume)$/.exec(payload.prompt);
  if (command) return { action: command[1] as 'pause' | 'resume' };
  const completion = /^\/banana-memory:memory complete-task ([:A-Za-z0-9_-]{1,128})$/.exec(payload.prompt);
  if (completion) return { action: 'complete-task', taskId: completion[1]! };
  const target = /^\/banana-memory:memory (pin|unpin|forget) ([:A-Za-z0-9_-]{1,128}) ([1-9][0-9]*)$/.exec(payload.prompt);
  if (target && Number.isSafeInteger(Number(target[3]))) return { action: target[1] === 'forget' ? 'delete-preview' : target[1] as 'pin' | 'unpin', target: target[2]!, expectedVersion: Number(target[3]) };
  const correct = /^\/banana-memory:memory correct ([:A-Za-z0-9_-]{1,128}) ([1-9][0-9]*) ([^\r\n]{1,8000})$/.exec(payload.prompt);
  if (correct && Number.isSafeInteger(Number(correct[2]))) return { action: 'correct', target: correct[1]!, expectedVersion: Number(correct[2]), text: correct[3]! };
  const deletion = /^\/banana-memory:memory confirm-delete ([:A-Za-z0-9_-]{1,128})$/.exec(payload.prompt);
  if (deletion) return { action: 'delete', previewId: deletion[1]! };
}

export async function resolveWorkspace(value: unknown): Promise<{ workspace: string | null; projectRoot?: string; scopeReason?: string }> {
  if (typeof value !== 'string' || !isAbsolute(value)) return { workspace: null, scopeReason: 'host_workspace_unavailable' };
  try {
    const workspace = await realpath(value);
    if (!(await stat(workspace)).isDirectory()) throw new Error('not_directory');
    // Linked worktrees and repository subdirectories share the main checkout's
    // identity. Keep the actual workspace for host file-boundary checks.
    try {
      const { stdout } = await promisify(execFile)('git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 1500, maxBuffer: 8192 });
      const common = await realpath(stdout.trim());
      if (common.endsWith('/.git')) {
        const projectRoot = dirname(common);
        if (projectRoot !== workspace) return { workspace, projectRoot };
      }
    } catch { /* Non-Git folders keep their canonical directory identity. */ }
    return { workspace };
  } catch { return { workspace: null, scopeReason: 'host_workspace_unavailable' }; }
}

function redactString(value: string, reasons: Set<string>): string {
  const result = value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED KEY]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
    .replace(/\b((?:[\w-]*(?:api[_-]?key|access[_-]?token|password|secret)[\w-]*)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi, '$1[REDACTED]');
  if (result !== value) reasons.add('recognized_secret');
  return result;
}

export function sanitizeText(value: string): { text: string; filtered: boolean; reasons: string[] } {
  const reasons = new Set<string>();
  const text = redactString(value, reasons);
  return { text, filtered: reasons.size > 0, reasons: [...reasons] };
}

function sanitize(value: unknown, reasons: Set<string>, depth = 0): unknown {
  if (depth > 20) { reasons.add('structure_limit'); return '[TRUNCATED STRUCTURE]'; }
  if (typeof value === 'string') return redactString(value, reasons);
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => sanitize(item, reasons, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 1000)) {
      if (SECRET_FIELD.test(key)) { output[key] = '[REDACTED]'; reasons.add('recognized_secret_field'); }
      else output[key] = sanitize(item, reasons, depth + 1);
    }
    return output;
  }
  return value;
}

function outside(workspace: string, file: string): boolean {
  const rel = relative(workspace, file);
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

function runtimeVersion(input: Record<string, unknown>, response: unknown): { runtime: RuntimeName; version: string } | undefined {
  if (typeof input.command !== 'string') return;
  const commands = new Set(['node --version', 'npm --version', 'pnpm --version', 'python --version', 'python3 --version']);
  if (!commands.has(input.command)) return;
  const runtime = normalizeRuntimeName(input.command.split(' ')[0]!);
  if (!runtime) return;
  const stdout = typeof response === 'string' ? response : response && typeof response === 'object' && 'stdout' in response ? response.stdout : undefined;
  if (typeof stdout !== 'string') return;
  // Preserve only an unambiguous numeric version, never surrounding output or
  // a shell command. Arbitrary shell output has no provable workspace scope.
  const pattern = runtime === 'python' ? /^(?:Python )?(\d{1,4}\.\d{1,4}\.\d{1,4})$/ : runtime === 'node' ? /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/ : /^(\d{1,4}\.\d{1,4}\.\d{1,4})$/;
  const versions = new Set(stdout.split(/\r?\n/).map(line => pattern.exec(line.trim())?.[1]).filter((value): value is string => !!value));
  if (versions.size !== 1) return;
  return { runtime, version: [...versions][0]! };
}

export async function normalizeHook(payload: Record<string, unknown>, workspace: string | null, taskId?: string): Promise<NormalizedEvent> {
  const kind = payload.hook_event_name as HookName;
  if (!HOOK_NAMES.includes(kind) || typeof payload.session_id !== 'string' || !payload.session_id) throw new Error('invalid_host_event');
  const reasons = new Set<string>();
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input as Record<string, unknown> : {};
  let excluded = false;
  for (const [key, value] of Object.entries(input)) {
    if (!['file_path', 'path', 'notebook_path'].includes(key) || typeof value !== 'string') continue;
    if (CREDENTIAL_PATH.test(value)) { reasons.add('credential_file'); excluded = true; }
    if (!workspace) { reasons.add('unbound_file_scope'); excluded = true; continue; }
    const absolute = resolve(workspace, value);
    let actual = absolute;
    try { actual = await realpath(absolute); } catch { /* A newly written path can be absent. */ }
    if (outside(workspace, actual)) { reasons.add('outside_workspace'); excluded = true; }
  }
  let raw: unknown = '';
  if (kind === 'UserPromptSubmit') raw = payload.prompt ?? '';
  if (kind === 'Stop') raw = payload.last_assistant_message ?? '[turn ended; task outcome not established]';
  if (kind === 'PostToolUse' || kind === 'PostToolUseFailure') raw = { input, result: payload.tool_response ?? payload.error ?? '' };
  if (kind === 'SessionStart') raw = { source: payload.source ?? 'startup' };
  if (kind === 'SessionEnd') raw = { reason: payload.reason ?? 'other' };
  let version: { runtime: RuntimeName; version: string } | undefined;
  if ((kind === 'PostToolUse' || kind === 'PostToolUseFailure') && payload.tool_name === 'Bash') {
    if (workspace && kind === 'PostToolUse' && !excluded) version = runtimeVersion(input, payload.tool_response);
    if (!version) { excluded = true; reasons.add('unverified_shell_scope'); }
    if (!workspace) { excluded = true; reasons.add('unbound_file_scope'); }
  }
  const cleaned = excluded ? '[FILTERED HOST EVENT]' : version ?? sanitize(raw, reasons);
  let text = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned);
  const truncated = text.length > MAX_TEXT || reasons.has('structure_limit');
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n[TRUNCATED HOST EVENT]';
  let transcriptPosition = '';
  // Only metadata is used to distinguish repeated prompts; historical transcript contents are never imported.
  if (typeof payload.transcript_path === 'string') {
    try { transcriptPosition = String((await stat(payload.transcript_path)).size); } catch { /* deterministic payload fallback */ }
  }
  const stableMarker = payload.tool_use_id ?? payload.event_id ?? transcriptPosition;
  const id = createHash('sha256').update(JSON.stringify([payload.session_id, kind, stableMarker, raw])).digest('hex');
  const now = new Date().toISOString();
  return {
    id, sourceRoot: id, sessionId: payload.session_id, taskId: kind === 'UserPromptSubmit' ? id : (taskId ?? `session:${payload.session_id}`),
    kind, role: kind === 'UserPromptSubmit' ? 'user' : kind === 'Stop' ? 'assistant' : kind.startsWith('PostTool') ? 'tool' : 'system',
    text, occurredAt: typeof payload.timestamp === 'string' && Number.isFinite(Date.parse(payload.timestamp)) ? payload.timestamp : now,
    receivedAt: now, truncated, filtered: reasons.size > 0, filterReasons: [...reasons],
    ...(typeof payload.tool_name === 'string' ? { toolName: payload.tool_name } : {}),
    ...(typeof payload.tool_use_id === 'string' ? { toolUseId: payload.tool_use_id } : {}),
    ...(kind === 'PostToolUse' ? { outcome: 'tool_success' as const } : kind === 'PostToolUseFailure' ? { outcome: 'tool_failure' as const } : {}),
  };
}
