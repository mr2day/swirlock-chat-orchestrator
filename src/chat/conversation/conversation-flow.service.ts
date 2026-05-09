import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SERVICE_CONFIG } from '../../config/config';
import type { ServiceConfig } from '../../config/config';
import { FragmenterClientService } from '../../fragmenter/fragmenter-client.service';
import type {
  LlmInputPart,
  LlmStreamEvent,
} from '../../llm-host/llm-host.service';
import { LlmHostService } from '../../llm-host/llm-host.service';
import { RagService } from '../../rag/rag.service';
import type {
  RagContext,
  RetrievalStreamEvent,
  UserLocation,
} from '../../rag/rag.service';
import { CappingService } from '../capping/capping.service';
import {
  ChatSessionService,
  extractImageParts,
  extractUserText,
} from '../chat-session.service';
import type { AgentActivityEvent } from '../commands/agent-command.types';
import { ControlLoopService } from '../control/control-loop.service';
import { DecisionsService } from '../decisions/decisions.service';
import type { PhaseEventEmitter } from '../decisions/decisions.service';
import { GeocodingService } from '../location/geocoding.service';
import { PersonaIdentityService } from '../persona/persona-identity.service';
import type { PersonaIdentityCapsule } from '../persona/persona-identity.service';
import { DecisionTraceService } from '../trace/decision-trace.service';
import type { ConversationHistoryView } from './conversation-history.service';
import { ConversationHistoryService } from './conversation-history.service';
import { ConversationPromptBuilderService } from './conversation-prompt-builder.service';
import type { SubmitTurnDto } from '../dto/submit-turn.dto';

export interface TurnDoneEnvelope {
  sessionId: string;
  turnId: string;
  assistantMessage: {
    messageId: string;
    content: string;
    createdAt: string;
  };
  finishReason: 'stop' | 'length' | 'error';
  citations: Array<{
    evidenceId: string;
    sourceTitle: string;
    sourceUrl?: string;
  }>;
  diagnostics?: {
    pipeline: 'control-loop' | 'decision-pipeline';
    retrievalUsed: boolean;
    retrievalMode: string;
    personaId: string;
    identityVersion: number;
    /** Populated only by the legacy control-loop pipeline. */
    agentSteps?: number;
    toolCommands?: number;
    commands?: string[];
  };
}

export interface RunTurnInput {
  sessionId: string;
  authUserId: string;
  correlationId: string;
  dto: SubmitTurnDto;
  abortSignal: AbortSignal;
  onAccepted: () => void;
  onClassifying: (info: { step: number }) => void;
  onRetrievalEvent: (event: RetrievalStreamEvent) => void;
  onAgentActivity: (event: AgentActivityEvent) => void;
  onModelEvent: (event: LlmStreamEvent) => void;
  onFinalChunk: (text: string) => void;
  /** Per-phase streaming events for the new Decision Pipeline. */
  onPhaseEvent?: PhaseEventEmitter;
  resolveUserLocation: () => Promise<UserLocation | null>;
}

interface AgentResult {
  assistantText: string;
  finishReason: 'stop' | 'length' | 'error';
  citations: Array<{
    evidenceId: string;
    sourceTitle: string;
    sourceUrl?: string;
  }>;
  diagnostics: NonNullable<TurnDoneEnvelope['diagnostics']>;
}

interface PreparedTurnContext {
  sessionId: string;
  correlationId: string;
  turnId: string;
  userText: string;
  identity: PersonaIdentityCapsule;
  view: ConversationHistoryView;
  llmParts: LlmInputPart[];
  initialLocation: UserLocation | undefined;
  thinking: boolean;
  occurredAt: string;
}

/**
 * Orchestrates one user turn end-to-end.
 *
 * Branches on `cfg.experimental.decisionPipeline`:
 * - When `false` (default while Phase F1 is landing): runs the
 *   legacy iterative agent control loop via `ControlLoopService`.
 * - When `true`: runs the linear Decision Pipeline (per
 *   `DECISION_PIPELINE.md`) — `needsSearch` → optional location
 *   resolution → `generateSearchQuery` → RAG → final-answer
 *   streaming. Each utilitarian step streams its tokens to the UI
 *   via `turn.phase.*` events, and records a `decision.*.completed`
 *   row in `decision_events`.
 */
@Injectable()
export class ConversationFlowService {
  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly sessions: ChatSessionService,
    private readonly history: ConversationHistoryService,
    private readonly persona: PersonaIdentityService,
    private readonly controlLoop: ControlLoopService,
    private readonly fragmenter: FragmenterClientService,
    private readonly geocoding: GeocodingService,
    private readonly decisions: DecisionsService,
    private readonly rag: RagService,
    private readonly llm: LlmHostService,
    private readonly conversationPromptBuilder: ConversationPromptBuilderService,
    private readonly trace: DecisionTraceService,
    private readonly capping: CappingService,
  ) {}

  async runTurn(input: RunTurnInput): Promise<TurnDoneEnvelope> {
    const ctx = await this.prepareTurnContext(input);

    let agentResult: AgentResult;
    try {
      if (this.cfg.experimental?.decisionPipeline === true) {
        agentResult = await this.runDecisionPipeline(input, ctx);
      } else {
        agentResult = await this.runControlLoop(input, ctx);
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'Turn pipeline failed',
      );
    }

    if (agentResult.assistantText.length === 0) {
      throw new ServiceUnavailableException(
        'Pipeline completed without producing final answer text',
      );
    }

    const persisted = this.sessions.appendTurn({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      parts: input.dto.message.parts,
      userText: ctx.userText,
      occurredAt: ctx.occurredAt,
      assistantText: agentResult.assistantText,
    });

    this.fragmenter.notifyObserved({
      sessionId: ctx.sessionId,
      lastTurnId: persisted.turnId,
      lastSeq: persisted.lastSeq,
      observedAt: persisted.createdAt,
    });

    const includeDiagnostics = input.dto.options?.includeDiagnostics === true;

    return {
      sessionId: ctx.sessionId,
      turnId: persisted.turnId,
      assistantMessage: {
        messageId: persisted.assistantMessageId,
        content: agentResult.assistantText,
        createdAt: persisted.createdAt,
      },
      finishReason: agentResult.finishReason,
      citations: agentResult.citations,
      ...(includeDiagnostics
        ? {
            diagnostics: {
              ...agentResult.diagnostics,
              personaId: ctx.identity.personaId,
              identityVersion: ctx.identity.identityVersion,
            },
          }
        : {}),
    };
  }

  private async prepareTurnContext(
    input: RunTurnInput,
  ): Promise<PreparedTurnContext> {
    const session = this.sessions.loadSession(
      input.sessionId,
      input.authUserId,
    );

    const userText = extractUserText(input.dto.message.parts);
    if (!userText) {
      throw new BadRequestException(
        'message.parts must contain at least one non-empty text part',
      );
    }
    const imageParts = extractImageParts(input.dto.message.parts);

    input.onAccepted();

    const view = this.history.loadHistoryView(input.sessionId);
    const identity = this.persona.prepareCapsule({
      personaId: session.personaId,
      userId: session.userId,
      sessionId: input.sessionId,
      occurredAt: input.dto.message.occurredAt,
    });

    const llmParts: LlmInputPart[] = imageParts.map((p) => ({
      type: 'image' as const,
      ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
      ...(p.imageBase64 ? { imageBase64: p.imageBase64 } : {}),
      ...(p.mimeType ? { mimeType: p.mimeType } : {}),
    }));

    const initialLocation = input.dto.userLocation
      ? await this.enrichLocation(
          this.normalizeUserLocation(input.dto.userLocation),
        )
      : undefined;

    return {
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      turnId: randomUUID(),
      userText,
      identity,
      view,
      llmParts,
      initialLocation,
      thinking: this.resolveInitialThinkingRequest(input.dto),
      occurredAt: input.dto.message.occurredAt,
    };
  }

  // ----- legacy control loop branch -----

  private async runControlLoop(
    input: RunTurnInput,
    ctx: PreparedTurnContext,
  ): Promise<AgentResult> {
    const result = await this.controlLoop.run({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      correlationId: ctx.correlationId,
      identity: ctx.identity,
      userText: ctx.userText,
      history: ctx.view.messages,
      consolidation: ctx.view.consolidation,
      ...(ctx.llmParts.length > 0 ? { llmParts: ctx.llmParts } : {}),
      occurredAt: ctx.occurredAt,
      ...(ctx.initialLocation
        ? { initialUserLocation: ctx.initialLocation }
        : {}),
      initialThinking: ctx.thinking,
      abortSignal: input.abortSignal,
      resolveUserLocation: async () => {
        const raw = await input.resolveUserLocation();
        return raw ? this.enrichLocation(raw) : null;
      },
      onClassifying: input.onClassifying,
      onAgentActivity: input.onAgentActivity,
      onRagStreamEvent: input.onRetrievalEvent,
      onModelEvent: input.onModelEvent,
      onFinalChunk: input.onFinalChunk,
    });

    return {
      assistantText: result.assistantText,
      finishReason: result.finishReason,
      citations: result.citations,
      diagnostics: {
        pipeline: 'control-loop',
        retrievalUsed: result.diagnostics.retrievalUsed,
        retrievalMode: result.diagnostics.retrievalMode,
        personaId: ctx.identity.personaId,
        identityVersion: ctx.identity.identityVersion,
        agentSteps: result.diagnostics.agentSteps,
        toolCommands: result.diagnostics.toolCommands,
        commands: result.diagnostics.commands,
      },
    };
  }

  // ----- new decision pipeline branch -----

  private async runDecisionPipeline(
    input: RunTurnInput,
    ctx: PreparedTurnContext,
  ): Promise<AgentResult> {
    const onPhase = input.onPhaseEvent;

    this.recordTrace(ctx, 'decision_pipeline.started', {
      summary: 'Decision pipeline took control of the turn flow.',
    });

    const needsSearch = await this.decisions.needsSearch({
      correlationId: ctx.correlationId,
      abortSignal: input.abortSignal,
      userText: ctx.userText,
      onPhase,
    });
    this.recordTrace(ctx, 'decision.needsSearch.completed', {
      summary: needsSearch ? 'Decided: search' : 'Decided: direct',
      payload: { result: needsSearch ? 'search' : 'direct' },
    });

    let location = ctx.initialLocation;
    let ragContext: RagContext | undefined;

    if (needsSearch) {
      if (!location) {
        const needsLocation = await this.decisions.needsLocation({
          correlationId: ctx.correlationId,
          abortSignal: input.abortSignal,
          userText: ctx.userText,
          onPhase,
        });
        this.recordTrace(ctx, 'decision.needsLocation.completed', {
          summary: needsLocation
            ? 'Decided: location needed'
            : 'Decided: location not needed',
          payload: { result: needsLocation ? 'needed' : 'skip' },
        });

        if (needsLocation) {
          onPhase?.({
            type: 'started',
            phase: 'location.resolve',
            label: 'Resolving location',
          });
          const raw = await input.resolveUserLocation();
          if (raw) {
            location = await this.enrichLocation(raw);
            const label = location.cityName
              ? `Located: ${location.cityName}${location.countryName ? `, ${location.countryName}` : ''}`
              : `Located: lat ${location.latitude}, lng ${location.longitude}`;
            onPhase?.({
              type: 'completed',
              phase: 'location.resolve',
              label,
              result: location,
            });
            this.recordTrace(ctx, 'location.resolve.completed', {
              summary: label,
              payload: { location },
            });
          } else {
            onPhase?.({
              type: 'completed',
              phase: 'location.resolve',
              label: 'Location not provided',
              result: null,
            });
            this.recordTrace(ctx, 'location.resolve.completed', {
              summary: 'User did not provide a location.',
              payload: { available: false },
            });
          }
        }
      }

      const query = await this.decisions.generateSearchQuery({
        correlationId: ctx.correlationId,
        abortSignal: input.abortSignal,
        userText: ctx.userText,
        ...(location
          ? {
              location: {
                ...(location.cityName ? { cityName: location.cityName } : {}),
                ...(location.countryName
                  ? { countryName: location.countryName }
                  : {}),
              },
            }
          : {}),
        onPhase,
      });
      this.recordTrace(ctx, 'decision.generateSearchQuery.completed', {
        summary: `Search query: ${query}`,
        payload: { query },
      });

      onPhase?.({
        type: 'started',
        phase: 'rag.retrieve',
        label: `Searching: "${query}"`,
      });
      try {
        ragContext = await this.rag.retrieve({
          correlationId: ctx.correlationId,
          sessionId: ctx.sessionId,
          userText: ctx.userText,
          parts: [{ type: 'text', text: query }],
          resolvedQueryText: query,
          freshness: this.cfg.rag.freshness,
          allowedModes: [...this.cfg.rag.allowedModes],
          ...(location ? { userLocation: location } : {}),
          onStreamEvent: input.onRetrievalEvent,
          abortSignal: input.abortSignal,
        });
        onPhase?.({
          type: 'completed',
          phase: 'rag.retrieve',
          label: `${ragContext.evidence.length} source${ragContext.evidence.length === 1 ? '' : 's'}`,
          result: {
            retrievalMode: ragContext.retrievalMode,
            evidenceCount: ragContext.evidence.length,
          },
        });
        this.recordTrace(ctx, 'rag.retrieve.completed', {
          summary: `Retrieved ${ragContext.evidence.length} evidence chunk(s).`,
          payload: {
            query,
            retrievalMode: ragContext.retrievalMode,
            evidenceCount: ragContext.evidence.length,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onPhase?.({
          type: 'failed',
          phase: 'rag.retrieve',
          message,
        });
        this.recordTrace(ctx, 'rag.retrieve.failed', {
          summary: message,
          payload: { query },
        });
        ragContext = undefined;
      }
    }

    onPhase?.({
      type: 'started',
      phase: 'final.streaming',
      label: 'Drafting answer',
    });
    this.recordTrace(ctx, 'final.streaming.started', {
      summary: 'Streaming final answer.',
    });

    const messages = this.conversationPromptBuilder.buildMessages({
      identity: ctx.identity,
      history: ctx.view.messages,
      consolidation: ctx.view.consolidation,
      userText: ctx.userText,
      occurredAt: ctx.occurredAt,
      observations: [],
      ragContexts: ragContext ? [ragContext] : [],
      activePlanSummary: null,
      activitySummary: null,
    });

    const finalCap = this.capping.forFinalAnswer({ messages });
    const ollama: Record<string, unknown> = {};
    if (finalCap !== undefined) ollama.num_predict = finalCap;

    const finalResult = await this.llm.streamInfer({
      correlationId: ctx.correlationId,
      messages,
      ...(ctx.llmParts.length > 0 ? { parts: ctx.llmParts } : {}),
      options: {
        responseFormat: 'text',
        thinking: ctx.thinking,
        ...(Object.keys(ollama).length > 0 ? { ollama } : {}),
      },
      abortSignal: input.abortSignal,
      onEvent: (evt) => {
        if (evt.type === 'chunk') {
          input.onFinalChunk(evt.payload.text);
          return;
        }
        input.onModelEvent(evt);
      },
    });

    onPhase?.({
      type: 'completed',
      phase: 'final.streaming',
      label: 'Answer streamed',
      result: { finishReason: finalResult.finishReason },
    });
    this.recordTrace(ctx, 'final.streaming.completed', {
      summary: `Streaming final answer completed with finishReason=${finalResult.finishReason}.`,
      payload: {
        finishReason: finalResult.finishReason,
        textLength: finalResult.text.length,
      },
    });

    return {
      assistantText: finalResult.text,
      finishReason: finalResult.finishReason,
      citations: this.citationsFrom(ragContext),
      diagnostics: {
        pipeline: 'decision-pipeline',
        retrievalUsed: ragContext?.retrievalUsed ?? false,
        retrievalMode: ragContext?.retrievalMode ?? 'none',
        personaId: ctx.identity.personaId,
        identityVersion: ctx.identity.identityVersion,
      },
    };
  }

  // ----- shared helpers -----

  private recordTrace(
    ctx: PreparedTurnContext,
    eventType: string,
    args: { summary: string; payload?: unknown; command?: string },
  ): void {
    this.trace.recordEvent({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      correlationId: ctx.correlationId,
      eventType,
      summary: args.summary,
      ...(args.command ? { command: args.command } : {}),
      ...(args.payload !== undefined ? { payload: args.payload } : {}),
    });
  }

  private citationsFrom(
    ragContext: RagContext | undefined,
  ): Array<{ evidenceId: string; sourceTitle: string; sourceUrl?: string }> {
    if (!ragContext) return [];
    const seen = new Set<string>();
    const out: Array<{
      evidenceId: string;
      sourceTitle: string;
      sourceUrl?: string;
    }> = [];
    for (const evidence of ragContext.evidence) {
      if (seen.has(evidence.evidenceId)) continue;
      seen.add(evidence.evidenceId);
      out.push({
        evidenceId: evidence.evidenceId,
        sourceTitle: evidence.sourceTitle,
        ...(evidence.sourceUrl ? { sourceUrl: evidence.sourceUrl } : {}),
      });
    }
    return out;
  }

  private resolveInitialThinkingRequest(dto: SubmitTurnDto): boolean {
    if (dto.options?.forceThinking === true) return true;
    if (dto.options?.thinking === false) return false;
    return false;
  }

  private normalizeUserLocation(value: {
    latitude: number;
    longitude: number;
    accuracyMeters?: number;
    capturedAt?: string;
  }): UserLocation {
    return {
      latitude: value.latitude,
      longitude: value.longitude,
      ...(value.accuracyMeters !== undefined
        ? { accuracyMeters: value.accuracyMeters }
        : {}),
      ...(value.capturedAt !== undefined
        ? { capturedAt: value.capturedAt }
        : {}),
    };
  }

  /**
   * Enriches a UserLocation with city/region/country derived from
   * reverse geocoding. The Vanamonde model can't infer these from raw
   * coordinates reliably, so we resolve them once before the location
   * is fed into prompts or used to construct rag.retrieve queries. If
   * geocoding fails, returns the input unchanged.
   */
  private async enrichLocation(loc: UserLocation): Promise<UserLocation> {
    const geo = await this.geocoding.reverseGeocode({
      latitude: loc.latitude,
      longitude: loc.longitude,
    });
    if (!geo) return loc;
    return {
      ...loc,
      ...(geo.cityName ? { cityName: geo.cityName } : {}),
      ...(geo.regionName ? { regionName: geo.regionName } : {}),
      ...(geo.countryName ? { countryName: geo.countryName } : {}),
      ...(geo.countryCode ? { countryCode: geo.countryCode } : {}),
    };
  }
}
