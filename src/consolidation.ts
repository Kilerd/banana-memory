import { digest, type MemoryData } from './domain.js';
import { normalizeRuntimeName } from './runtime-names.js';

/** Extract only explicit, recognized dependency versions from evidence, never from arbitrary filenames. */
export function environmentDependencies(text: string, conditions: string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const condition of conditions) {
    const match = /^([a-zA-Z][\w.-]*)=(.+)$/.exec(condition);
    if (match) environment[normalizeRuntimeName(match[1]!) ?? match[1]!.toLowerCase()] = match[2]!;
  }
  for (const match of text.matchAll(/\b(Node(?:\.js)?|macOS|Python(?:3)?|pnpm|npm)\s*(?:版本|version|[=v:])?\s*(\d+(?:\.\d+){0,2})(?![\d.])/gi)) {
    const key = normalizeRuntimeName(match[1]!) ?? match[1]!.toLowerCase();
    environment[key] = match[2]!;
  }
  return environment;
}

export function versionMatches(required: string, actual?: string): boolean {
  if (!actual) return false;
  if (required === actual) return true;
  return /^\d+(?:\.\d+){0,2}$/.test(required) && actual.startsWith(required + '.');
}

export function temporalFields(text: string, taskId: string): { temporary: boolean; taskId: string; expiresAt?: string } {
  const temporary = /当前任务状态|临时任务状态|任务进行中|current task state|temporary task|work in progress/i.test(text);
  const expiry = /(?:有效期至|到期时间|expires(?: at)?|valid until)\s*[:：]?\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?)/i.exec(text)?.[1];
  const instant = expiry?.includes('T') ? expiry : expiry ? expiry + 'T23:59:59.999Z' : undefined;
  return { temporary, taskId, expiresAt: instant && Number.isFinite(Date.parse(instant)) ? instant : undefined };
}

function shingles(text: string): Set<string> {
  const chars = [...text.toLowerCase().replace(/[\s\p{P}]/gu, '')];
  return new Set(chars.slice(0, -2).map((c, i) => c + chars[i + 1] + chars[i + 2]));
}
export function textSimilarity(left: string, right: string): number {
  const a = shingles(left), b = shingles(right);
  if (!a.size || !b.size) return left === right ? 1 : 0;
  return [...a].filter(value => b.has(value)).length / Math.min(a.size, b.size);
}
function qualifiers(text: string): string {
  return JSON.stringify({ numbers: [...text.matchAll(/\d+(?:\.\d+)*/g)].map(m => m[0]).sort(),
    negative: /\bnot\b|\bnever\b|\bexcept\b|不|未|禁止|除外|除非/i.test(text) });
}
export function canConsolidate(left: MemoryData, right: MemoryData): boolean {
  return left.type === right.type && left.type === 'episode' && qualifiers(left.text) === qualifiers(right.text) &&
    JSON.stringify([...left.conditions].sort()) === JSON.stringify([...right.conditions].sort()) &&
    JSON.stringify(left.environment) === JSON.stringify(right.environment) && textSimilarity(left.text, right.text) >= 0.82;
}
export function experienceId(projectId: string, members: string[]): string { return 'm:' + digest(projectId + ':experience:' + [...members].sort().join('|')); }

/** A narrow contradiction detector can withdraw a candidate; it cannot establish a new truth. */
export function conflictCandidate(left: MemoryData, right: MemoryData): boolean {
  if (!['fact', 'preference'].includes(left.type) || left.type !== right.type || left.text === right.text) return false;
  const neutral = (text: string) => text.toLowerCase().replace(/\bnot\b|\bnever\b|(?<![\w])\d+(?:\.\d+)*|不|未|禁止/g, '').replace(/[\s\p{P}]/gu, '');
  return neutral(left.text).length >= 5 && neutral(left.text) === neutral(right.text) && qualifiers(left.text) !== qualifiers(right.text);
}
