import { digest, effectiveState, type MemoryData } from './domain.js';
import { textSimilarity } from './consolidation.js';
import type { StoredRecord } from './store.js';
import type { MemorySummary, SummaryMember } from './models/types.js';

export const SUMMARY_POLICY = 'candidate-summary-4';
export const summaryFingerprint = (rows: StoredRecord[]): string => digest(SUMMARY_POLICY + rows.map(row => `${row.id}:${row.version}`).sort().join('|'));
export const summaryMember = (row: StoredRecord): SummaryMember => ({ id: row.id, text: String(row.data.text), createdAt: String(row.data.createdAt), conditions: (row.data as MemoryData).conditions, environment: (row.data as MemoryData).environment });

/** Only original memories contribute. Derivations never corroborate themselves. */
export function summaryGroups(rows: StoredRecord[], now: number, environment: Record<string, string>): StoredRecord[][] {
  const eligible = rows.filter(row => ['fact', 'preference', 'episode'].includes(String(row.data.type)) &&
    ['candidate', 'active'].includes(effectiveState(row.data as MemoryData, now, environment)) &&
    !row.data.temporary && !(row.data.expiresAt && Date.parse(String(row.data.expiresAt)) <= now))
    .sort((a, b) => a.id.localeCompare(b.id));
  const groups: StoredRecord[][] = [];
  const remaining = new Set(eligible);
  for (const seed of eligible) {
    if (!remaining.has(seed)) continue;
    const similarity = (other: StoredRecord, anchor = seed): number => {
      if (anchor.vector && other.vector && anchor.data.embeddingVersion === other.data.embeddingVersion) {
        const dot = anchor.vector.reduce((sum, value, index) => sum + value * other.vector![index]!, 0);
        const norm = Math.sqrt(anchor.vector.reduce((sum, x) => sum + x * x, 0) * other.vector.reduce((sum, x) => sum + x * x, 0));
        return norm ? dot / norm : 0;
      }
      return textSimilarity(String(anchor.data.text), String(other.data.text));
    };
    const threshold = (left: StoredRecord, right: StoredRecord) => left.vector && right.vector && left.data.embeddingVersion === right.data.embeddingVersion ? 0.70 : 0.35;
    const neighbors = [...remaining].filter(row => row !== seed)
      .map(row => ({ row, score: similarity(row) })).filter(item => item.score >= threshold(seed, item.row))
      .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
    const members = [seed];
    let bytes = Buffer.byteLength(String(seed.data.text));
    for (const { row } of neighbors) {
      const size = Buffer.byteLength(String(row.data.text));
      if (bytes + size > 6000 || members.length >= 6) continue;
      if (members.some(member => similarity(row, member) < threshold(row, member))) continue;
      members.push(row); bytes += size;
    }
    if (members.length < 3) continue;
    members.forEach(row => remaining.delete(row));
    groups.push(members);
  }
  return groups;
}

export function validSummary(value: MemorySummary | null, members: SummaryMember[]): value is MemorySummary {
  return !!value && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 1600 &&
    Array.isArray(value.evidence) && value.evidence.length >= members.length && value.evidence.length <= 12 &&
    members.every(member => value.evidence.some(e => e.memberId === member.id)) &&
    value.evidence.every(e => typeof e.quote === 'string' && e.quote.trim().length > 0 && members.some(m => m.id === e.memberId && m.text.includes(e.quote)));
}
