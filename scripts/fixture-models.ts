import { createHash } from 'node:crypto';
import type { LocalModels, MemoryCandidate, ModelEvent, ModelStatus } from '../src/models/types.js';

export interface FixtureExtraction { text: string; type: MemoryCandidate['type']; scope?: MemoryCandidate['scope']; conditions: string[] }

/** A replay double, never selected by the application or installer. It has no
 * access to query expectations, memory ids or correctness labels. */
export class FixtureModels implements LocalModels {
  constructor(private readonly extractions: FixtureExtraction[], private readonly embedding?: Pick<LocalModels, 'embed'>) {}
  status(): ModelStatus {
    return { phase: 'ready', generationLoaded: false, embeddingLoaded: !!this.embedding,
      modelVersion: this.embedding ? 'fixture-extraction-real-embedding' : 'deterministic-replay-fixture' };
  }
  async prepare(): Promise<void> {}
  async extract(events: ModelEvent[]): Promise<MemoryCandidate[]> {
    return events.flatMap(event => this.extractions.filter(candidate => candidate.text === event.text).map(candidate => ({
      type: candidate.type, scope: candidate.scope ?? 'project', text: candidate.text, conditions: candidate.conditions,
      sourceIds: [event.id], evidence: [{ sourceId: event.id, quote: event.text }], confidence: 0.99,
    })));
  }
  async embed(text: string, purpose: 'query' | 'document'): Promise<number[]> {
    if (this.embedding) return this.embedding.embed(text, purpose);
    const vector = Array.from({ length: 1024 }, () => 0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [text];
    for (const token of tokens) {
      const bytes = createHash('sha256').update(token).digest();
      const index = bytes.readUInt16LE(0) % vector.length;
      vector[index] = vector[index]! + 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map(value => value / norm);
  }
  async shutdown(): Promise<void> {}
}
