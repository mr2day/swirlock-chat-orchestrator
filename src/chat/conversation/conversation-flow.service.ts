import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  LlmInputPart,
  LlmStreamEvent,
} from '../../llm-host/llm-host.service';
import type { RetrievalStreamEvent, UserLocation } from '../../rag/rag.service';
import { FragmenterClientService } from '../../fragmenter/fragmenter-client.service';
import {
  ChatSessionService,
  extractImageParts,
  extractUserText,
} from '../chat-session.service';
import type { AgentActivityEvent } from '../commands/agent-command.types';
import { ControlLoopService } from '../control/control-loop.service';
import { PersonaIdentityService } from '../persona/persona-identity.service';
import { ConversationHistoryService } from './conversation-history.service';
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
    agentSteps: number;
    toolCommands: number;
    commands: string[];
    retrievalUsed: boolean;
    retrievalMode: string;
    personaId: string;
    identityVersion: number;
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
  resolveUserLocation: () => Promise<UserLocation | null>;
}

/**
 * Orchestrates one user turn end-to-end:
 *  1. validate auth and load the session
 *  2. extract user text + image parts from the DTO
 *  3. load the conversation history view (messages + fragmenter
 *     consolidation, if any)
 *  4. prepare the persona identity capsule
 *  5. run the control loop (with the conversation prompt builder used
 *     for the final answer and one of the registered commands used at
 *     each tool step)
 *  6. atomically append the user + assistant messages to the live
 *     tables and return the identifiers
 *  7. fire-and-forget `session.observed` to the fragmenter
 */
@Injectable()
export class ConversationFlowService {
  constructor(
    private readonly sessions: ChatSessionService,
    private readonly history: ConversationHistoryService,
    private readonly persona: PersonaIdentityService,
    private readonly controlLoop: ControlLoopService,
    private readonly fragmenter: FragmenterClientService,
  ) {}

  async runTurn(input: RunTurnInput): Promise<TurnDoneEnvelope> {
    const { sessionId, authUserId, correlationId, dto, abortSignal } = input;
    const session = this.sessions.loadSession(sessionId, authUserId);

    const userText = extractUserText(dto.message.parts);
    if (!userText) {
      throw new BadRequestException(
        'message.parts must contain at least one non-empty text part',
      );
    }
    const imageParts = extractImageParts(dto.message.parts);

    input.onAccepted();

    const view = this.history.loadHistoryView(sessionId);
    const identity = this.persona.prepareCapsule({
      personaId: session.personaId,
      userId: session.userId,
      sessionId,
      occurredAt: dto.message.occurredAt,
    });

    const llmParts: LlmInputPart[] = imageParts.map((p) => ({
      type: 'image' as const,
      ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
      ...(p.imageBase64 ? { imageBase64: p.imageBase64 } : {}),
      ...(p.mimeType ? { mimeType: p.mimeType } : {}),
    }));

    const initialUserLocation = dto.userLocation
      ? this.normalizeUserLocation(dto.userLocation)
      : undefined;

    const turnId = randomUUID();

    let agentResult: Awaited<ReturnType<ControlLoopService['run']>>;
    try {
      agentResult = await this.controlLoop.run({
        sessionId,
        turnId,
        correlationId,
        identity,
        userText,
        history: view.messages,
        consolidation: view.consolidation,
        ...(llmParts.length > 0 ? { llmParts } : {}),
        occurredAt: dto.message.occurredAt,
        ...(initialUserLocation ? { initialUserLocation } : {}),
        initialThinking: this.resolveInitialThinkingRequest(dto),
        abortSignal,
        resolveUserLocation: input.resolveUserLocation,
        onClassifying: input.onClassifying,
        onAgentActivity: input.onAgentActivity,
        onRagStreamEvent: input.onRetrievalEvent,
        onModelEvent: input.onModelEvent,
        onFinalChunk: input.onFinalChunk,
      });
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'Agent loop failed',
      );
    }

    if (agentResult.assistantText.length === 0) {
      throw new ServiceUnavailableException(
        'Agent completed without producing final answer text',
      );
    }

    const persisted = this.sessions.appendTurn({
      sessionId,
      turnId,
      parts: dto.message.parts,
      userText,
      occurredAt: dto.message.occurredAt,
      assistantText: agentResult.assistantText,
    });

    this.fragmenter.notifyObserved({
      sessionId,
      lastTurnId: persisted.turnId,
      lastSeq: persisted.lastSeq,
      observedAt: persisted.createdAt,
    });

    const includeDiagnostics = dto.options?.includeDiagnostics === true;

    return {
      sessionId,
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
              personaId: identity.personaId,
              identityVersion: identity.identityVersion,
            },
          }
        : {}),
    };
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
}
