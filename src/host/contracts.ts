/** This identity is established by a trusted launcher, never by MCP arguments. */
export interface HostIdentity {
  workspace: string | null;
  sessionId: string;
  origin: 'hook' | 'mcp';
  scopeReason?: string;
  /** HTTP + Skill mode has no trusted host hooks, so it may retrieve clearly
   * labelled candidate memories without granting them user authority. */
  includeCandidates?: boolean;
}

export type HookName = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop' | 'SessionEnd';
export interface NormalizedEvent {
  id: string;
  sourceRoot: string;
  sessionId: string;
  taskId: string;
  kind: HookName;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  occurredAt: string;
  receivedAt: string;
  truncated: boolean;
  filtered: boolean;
  filterReasons: string[];
  toolName?: string;
  toolUseId?: string;
  outcome?: 'tool_success' | 'tool_failure';
}

/** Only parseExplicitIntent can construct this from top-level UserPromptSubmit. */
export type ExplicitIntent =
  | { action: 'pause' | 'resume' }
  | { action: 'complete-task'; taskId: string }
  | { action: 'pin' | 'unpin'; target: string; expectedVersion: number }
  | { action: 'correct'; target: string; expectedVersion: number; text: string }
  | { action: 'delete-preview'; target: string; expectedVersion: number }
  | { action: 'delete'; previewId: string };

export type MemoryTool = 'recall' | 'record' | 'feedback' | 'inspect' | 'manage';
export interface HookResult { additionalContext?: string; [key: string]: unknown }

/** Domain integration implements this interface. The kernel is its sole owner. */
export interface ServerBackend {
  bind(identity: HostIdentity): Promise<unknown>;
  handleHook(context: unknown, event: NormalizedEvent, intent?: ExplicitIntent): Promise<HookResult>;
  call(context: unknown, tool: MemoryTool, args: Record<string, unknown>): Promise<unknown>;
  /** Explicit local CLI retry; the same kernel remains the only model owner. */
  retryModels?(): Promise<unknown>;
  close(): Promise<void>;
}
export type BackendFactory = (dataDir: string) => Promise<ServerBackend>;
