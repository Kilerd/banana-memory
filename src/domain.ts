import { createHash } from 'node:crypto';
import { versionMatches } from './consolidation.js';

export const POLICY_VERSION = 'memory-policy-1';
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export type MemoryState = 'candidate' | 'active' | 'review' | 'superseded' | 'archived';
export type MemoryType = 'fact' | 'preference' | 'episode' | 'experience';
export type ErrorCode = 'PAUSED' | 'UNAUTHORIZED' | 'VERSION_CONFLICT' | 'SOURCE_DELETED' | 'TIMEOUT' | 'PROCESSING_FAILED' | 'INVALID_INPUT';
export class MemoryError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); this.name = 'MemoryError'; }
}
export interface Scope { projectId: string; sessionId: string; origin: 'hook' | 'mcp'; reason?: string; includeCandidates?: boolean }
export interface EventInput {
  id: string; text: string; role?: 'user' | 'assistant' | 'tool' | 'system';
  taskId?: string; sourceRoot?: string; occurredAt?: string; truncated?: boolean;
  filtered?: boolean; filterReasons?: string[]; kind?: string; outcome?: string; sourceIds?: string[];
}
export interface EventData extends Record<string, unknown> {
  text: string; role: 'user' | 'assistant' | 'tool' | 'system'; taskId: string; sessionId: string;
  root: string; occurredAt: string; receivedAt: string; trusted: boolean;
  truncated: boolean; filtered: boolean; filterReasons: string[];
}
export function isDirectUserStatement(event: EventData): boolean {
  return event.trusted && event.role === 'user' && !event.truncated && !event.filtered &&
    !/(^\s*[>"“‘]|```|\b(?:quoted|pasted|third.party|user_confirmed|said|says|wrote|according to|README)\b|引用|转述|第三方|别人说|文档中|文章中|他说|她说)/im.test(event.text);
}
export interface MemoryData extends Record<string, unknown> {
  type: MemoryType; text: string; state: MemoryState; conditions: string[]; sources: string[];
  environment: Record<string, string>; createdAt: string; updatedAt: string;
  pinned: boolean; lastReusedAt?: string; expiresAt?: string; temporary?: boolean;
  modelVersion: string; policyVersion: string; reason: string;
}
export interface RecallMemory { id: string; version: number; text: string; type: MemoryType; state: MemoryState; sources: string[]; conditions: string[]; updatedAt: string; score: number }
export interface ContextBundle { id: string; projectId: string; generation: number; memories: RecallMemory[]; text: string; tokens: number; degradation?: string; delivered: boolean; mode?: 'current' | 'history' }

// UTF-8 byte count is a fixed, conservative upper bound for byte-fallback tokenizers.
export const tokenCount = (text: string): number => Buffer.byteLength(text, 'utf8');
export function lexicalScore(query: string, text: string): number {
  const haystack = text.toLowerCase();
  const words = query.toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const tokens = words.flatMap(word => /[\p{Script=Han}]/u.test(word) ? [...word].slice(0, -1).map((c, i) => c + [...word][i + 1]) : [word]);
  if (!tokens.length) return 0;
  return tokens.reduce((score, word) => score + (haystack.includes(word) ? (/\d/.test(word) ? 4 : 1) : 0), 0) / tokens.length;
}
export function effectiveState(memory: MemoryData, now: number, environment: Record<string, string>): MemoryState {
  if (memory.state !== 'active') return memory.state;
  if (memory.expiresAt && Date.parse(memory.expiresAt) <= now) return 'review';
  if (Object.entries(memory.environment).some(([key, value]) => !versionMatches(value, environment[key]))) return 'review';
  const age = now - Date.parse(memory.lastReusedAt ?? memory.updatedAt);
  if (memory.temporary && age > 7 * 86400_000) return 'review';
  if (memory.type === 'episode' && !memory.pinned && age > 180 * 86400_000) return 'archived';
  return memory.state;
}
export function ageWeight(memory: MemoryData, now: number): number {
  if (memory.pinned || memory.type === 'fact' || memory.type === 'preference') return 1;
  const days = Math.max(0, now - Date.parse(memory.updatedAt)) / 86400_000;
  return Math.pow(0.5, days / (memory.type === 'episode' ? 30 : 90));
}

/** Recognize a narrow, explicit outcome declaration, never a keyword mention.
 * Callers must still establish trusted direct-user provenance independently.
 * Negated domain conditions (for example "不得删除数据") remain valid evidence.
 */
export function classifyOutcome(text: string): 'success' | 'failure' | 'unverified' {
  const statement = text.trim();
  if (!statement || /[\r\n?？]/u.test(statement)) return 'unverified';
  const declaration = /^(验证通过|结果符合预期|verified success|verified outcome|验证失败(?:\s*[，,]\s*反例)?|反例|verified failure|counterexample)\s*[:：]\s*(\S[\s\S]*)$/iu.exec(statement);
  if (!declaration) return 'unverified';
  const body = declaration[2]!;
  // Contradictory outcome language is different from restrictions on an action.
  if (/^(?:尚未|还未|并未|从未|没有|未能|无法|未)(?:验证(?:通过|成功|完成)|确认(?:成功|结果)|完成验证)/u.test(body) ||
      /^(?:(?:we|i)\s+(?:have\s+|did\s+)?not\s+|not\s+(?:yet\s+)?|never\s+)(?:verified|verify|confirmed|confirm)\b/iu.test(body) ||
      /^(?:unverified|pending verification|not (?:yet )?(?:successful|complete|completed))\b/iu.test(body) ||
      /^(?:是否|是不是|能否|可否|难道)/u.test(body) || /^(?:can|could|did|do|does|should|would|will|is|are|has|have)\s/iu.test(body)) return 'unverified';
  return /^(?:验证通过|结果符合预期|verified success|verified outcome)$/iu.test(declaration[1]!) ? 'success' : 'failure';
}
