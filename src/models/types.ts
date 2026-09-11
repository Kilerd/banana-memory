export type ModelErrorCode = 'MODEL_PREPARING' | 'DOWNLOAD_FAILED' | 'DISK_FULL' | 'CHECKSUM_MISMATCH' | 'UNSUPPORTED_PLATFORM' | 'MODEL_TIMEOUT' | 'MODEL_OUTPUT_INVALID' | 'MODEL_STOPPED' | 'MODEL_FAILED';

export class ModelError extends Error {
  constructor(public readonly code: ModelErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'ModelError'; }
}

export interface ModelEvent {
  id: string;
  text: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  truncated?: boolean;
}

export interface MemoryCandidate {
  type: 'fact' | 'preference' | 'episode' | 'experience';
  scope: 'project' | 'global';
  text: string;
  sourceIds: string[];
  conditions: string[];
  confidence: number;
  evidence: Array<{ sourceId: string; quote: string }>;
}

export interface ModelStatus {
  phase: 'initializing' | 'downloading' | 'loading' | 'ready' | 'degraded' | 'stopped';
  resource?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  generationLoaded: boolean;
  embeddingLoaded: boolean;
  error?: { code: ModelErrorCode; message: string; retryable: boolean };
  modelVersion: string;
}

export interface LocalModels {
  status(): ModelStatus;
  prepare(): Promise<void>;
  extract(events: ModelEvent[]): Promise<MemoryCandidate[]>;
  embed(text: string, purpose: 'query' | 'document'): Promise<number[]>;
  shutdown(): Promise<void>;
  /** An explicit user retry is required after a persistent download failure. */
  retry?(): Promise<void>;
}

export interface Resource {
  id: 'generation' | 'embedding' | 'runtime';
  repository: string;
  revision: string;
  filename: string;
  url: string;
  size: number;
  sha256: string;
  license: string;
}

export interface ModelManifest {
  version: string;
  platform: string;
  arch: string;
  resources: Resource[];
  runtimeExecutable: string;
  generation: { contextTokens: number; inputTokens: number; outputTokens: number };
  embedding: { dimensions: number; pooling: 'last'; normalization: 'l2'; queryInstruction: string };
}
