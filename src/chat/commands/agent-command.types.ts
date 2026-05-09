import type {
  RagContext,
  RetrievalStreamEvent,
  UserLocation,
} from '../../rag/rag.service';

export type AgentMode = 'final' | 'command';

export interface AgentFrame {
  mode: AgentMode;
  command?: string;
  arguments?: Record<string, unknown>;
  reason?: string;
}

export interface AgentObservation {
  kind: string;
  summary: string;
  data?: unknown;
}

export interface AgentCommandResult {
  observation: AgentObservation;
  ragContext?: RagContext;
  thinking?: boolean;
  userLocation?: UserLocation;
}

export interface AgentActivityEvent {
  command?: string;
  phase: 'classifying' | 'command_started' | 'command_completed' | 'plan';
  summary: string;
  data?: unknown;
}

export interface AgentCommandContext {
  sessionId: string;
  turnId: string;
  correlationId: string;
  userText: string;
  userLocation?: UserLocation;
  abortSignal?: AbortSignal;
  onAgentActivity?: (event: AgentActivityEvent) => void;
  onRagStreamEvent?: (event: RetrievalStreamEvent) => void;
  resolveUserLocation?: () => Promise<UserLocation | null>;
}

/**
 * Common shape every agent command implements. The control loop owns
 * the per-step bookkeeping (trace events for `command.requested`,
 * `command.completed`, `command.failed`); each command file is just
 * the action.
 */
export interface AgentCommand {
  /** The exact command name used in the JSON control frame. */
  readonly name: string;
  /** Short user-facing label rendered for `command_started` events. */
  startedSummary(commandArgs: Record<string, unknown>): string;
  execute(
    ctx: AgentCommandContext,
    commandArgs: Record<string, unknown>,
  ): Promise<AgentCommandResult> | AgentCommandResult;
}
