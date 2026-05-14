import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SERVICE_CONFIG } from '../../config/config';
import type { ServiceConfig } from '../../config/config';
import { FragmenterClientService } from '../../fragmenter/fragmenter-client.service';
import { FragmenterReaderService } from '../../fragmenter/fragmenter-reader.service';
import type {
  LlmInputPart,
  LlmStreamEvent,
} from '../../llm-host/llm-host.service';
import { LlmHostService } from '../../llm-host/llm-host.service';
import type {
  RagEvidence,
  RetrievalStreamEvent,
  UserLocation,
} from '../../rag/rag.service';
import { CappingService } from '../capping/capping.service';
import {
  ChatSessionService,
  extractImageParts,
  extractUserText,
} from '../chat-session.service';
import { ConversationHistoryService } from '../conversation/conversation-history.service';
import { GeocodingService } from '../location/geocoding.service';
import { DecisionTraceService } from '../trace/decision-trace.service';
import type { ConversationMessage } from '../conversation/conversation-history.service';
import type { SubmitTurnDto } from '../dto/submit-turn.dto';
import type { CommandKind, ParsedCommands } from './command-parser';
import { parseCommands } from './command-parser';
import { CommandFulfillerService } from './command-fulfiller.service';
import {
  buildAnswerPrompt,
  buildAssessmentPrompt,
  type HistoryTurn,
} from './reverse-control-prompts';

const RECENT_HISTORY_LIMIT = 12;

/**
 * Approximate token budget for the recent-history block we send the
 * classifier. Capped by tokens, not message count: long assistant
 * replies (multi-thousand-char music biographies, etc.) bloat the
 * classifier prefill latency into multi-second territory without
 * helping the classification decision. The classifier mainly needs
 * enough context to resolve pronouns in the current user query;
 * older detail is dead weight.
 *
 * Sized roughly around 2 recent assistant replies of typical length.
 */
const CLASSIFIER_HISTORY_TOKEN_BUDGET = 2000;

export type PhaseEvent =
  | { type: 'started'; phase: string; label: string }
  | { type: 'token'; phase: string; text: string }
  | { type: 'completed'; phase: string; label?: string; result?: unknown }
  | { type: 'failed'; phase: string; message: string };

export type PhaseEventEmitter = (event: PhaseEvent) => void;

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
    commands: string[];
    thinkingUsed: boolean;
  };
}

export interface RunTurnInput {
  sessionId: string;
  authUserId: string;
  correlationId: string;
  dto: SubmitTurnDto;
  abortSignal: AbortSignal;
  onAccepted: () => void;
  onRetrievalEvent: (event: RetrievalStreamEvent) => void;
  onModelEvent: (event: LlmStreamEvent) => void;
  onFinalChunk: (text: string) => void;
  onPhaseEvent?: PhaseEventEmitter;
  resolveUserLocation: () => Promise<UserLocation | null>;
}

interface PreparedTurnContext {
  sessionId: string;
  correlationId: string;
  turnId: string;
  userText: string;
  userId: string;
  personaName: string | null;
  personaSystemPrompt: string | null;
  history: ConversationMessage[];
  llmParts: LlmInputPart[];
  initialLocation: UserLocation | undefined;
  occurredAt: string;
}

interface FulfilledLine {
  command: CommandKind;
  value: string;
}

/**
 * Reverse-control flow (Nick's commands format).
 *
 * Each turn runs in two rounds:
 *
 *   1. Assessment — orchestrator pre-injects the user's date+time and
 *      city+country into a meta-section, then asks the LLM whether it
 *      needs LOCATION / DATE_TIME / THINKING / SEARCH commands or can
 *      answer DIRECT. The LLM responds with `[command="..."]` (and
 *      `[search_prompt="..."]` if SEARCH).
 *      Always uses thinking=false (utilitarian).
 *
 *   2. Answer — orchestrator fulfills any non-flag commands (SEARCH
 *      via RAG; LOCATION/DATE_TIME re-stated for completeness) and
 *      asks the LLM to compose the user-visible reply, with all
 *      gathered context in the meta-section. Plain text streams to
 *      the user. Uses thinking=true iff the LLM asked for THINKING in
 *      round 1.
 */
@Injectable()
export class ReverseControlFlowService {
  private readonly log = new Logger(ReverseControlFlowService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly sessions: ChatSessionService,
    private readonly history: ConversationHistoryService,
    private readonly fragmenter: FragmenterClientService,
    private readonly fragmenterReader: FragmenterReaderService,
    private readonly geocoding: GeocodingService,
    private readonly llm: LlmHostService,
    private readonly trace: DecisionTraceService,
    private readonly capping: CappingService,
    private readonly fulfiller: CommandFulfillerService,
  ) {}

  async runTurn(input: RunTurnInput): Promise<TurnDoneEnvelope> {
    const ctx = await this.prepareTurnContext(input);
    const onPhase = input.onPhaseEvent;

    let location = ctx.initialLocation;
    const cityCountry = this.formatCityCountry(location);
    const dateTime = this.formatDateTime(ctx.occurredAt);

    this.recordTrace(ctx, 'reverse_control.started', {
      summary: `Reverse-control flow took control of the turn. Pre-injected city=${cityCountry ?? '(unknown)'}, dateTime=${dateTime}.`,
    });

    const fulfilled: FulfilledLine[] = [];
    const evidenceById = new Map<string, RagEvidence>();
    let thinkingForAnswer = false;
    let parsed: ParsedCommands;

    try {
      // ------- assessment round -------
      const assessmentMessages = buildAssessmentPrompt({
        userText: ctx.userText,
        cityCountry,
        dateTime,
        recentHistoryBlock: this.renderHistoryBlock(ctx.history),
        personaSystemPrompt: ctx.personaSystemPrompt,
      });

      onPhase?.({
        type: 'started',
        phase: 'assessment',
        label: 'Classifying...',
      });

      const cap = this.capping.forUtilitarianDecision({
        messages: assessmentMessages,
      });
      const ollama: Record<string, unknown> = { temperature: 0 };
      if (cap !== undefined) ollama.num_predict = cap;

      const assessment = await this.llm.streamInfer({
        correlationId: ctx.correlationId,
        messages: assessmentMessages,
        options: { responseFormat: 'text', thinking: false, ollama },
        abortSignal: input.abortSignal,
        onEvent: (evt) => {
          if (evt.type === 'chunk' && evt.payload.text) {
            onPhase?.({
              type: 'token',
              phase: 'assessment',
              text: evt.payload.text,
            });
          }
        },
      });

      parsed = parseCommands(assessment.text);
      thinkingForAnswer = parsed.commands.has('THINKING');

      onPhase?.({
        type: 'completed',
        phase: 'assessment',
        label: this.summariseParsed(parsed),
        result: {
          commands: [...parsed.commands],
          ...(parsed.searchPrompt ? { searchPrompt: parsed.searchPrompt } : {}),
        },
      });
      this.recordTrace(ctx, 'assessment.completed', {
        summary: this.summariseParsed(parsed),
        payload: {
          commands: [...parsed.commands],
          ...(parsed.searchPrompt ? { searchPrompt: parsed.searchPrompt } : {}),
        },
      });

      // ------- fulfillment -------
      // LOCATION and DATE_TIME without a search_prompt are skipped:
      // user values are already pre-injected in the meta-section.
      // With a search_prompt, they trigger a labelled web search.
      // SEARCH always runs a web search.
      const fulfillment = this.planFulfillment(parsed);
      for (const step of fulfillment) {
        const phaseId = `command.${step.label}`;
        onPhase?.({
          type: 'started',
          phase: phaseId,
          label: this.startedLabelFor(step.label, parsed),
        });
        const result = await this.fulfiller.fulfill(
          step.label,
          parsed,
          {
            correlationId: ctx.correlationId,
            sessionId: ctx.sessionId,
            userText: ctx.userText,
            occurredAt: ctx.occurredAt,
            abortSignal: input.abortSignal,
            initialLocation: location,
            resolveUserLocation: input.resolveUserLocation,
            onRetrievalStreamEvent: input.onRetrievalEvent,
          },
          location,
        );
        if (result.patch?.location) {
          location = result.patch.location;
        }
        if (result.value) {
          fulfilled.push({ command: step.label, value: result.value });
        }
        if (result.evidence) {
          for (const ev of result.evidence) {
            if (!evidenceById.has(ev.evidenceId)) {
              evidenceById.set(ev.evidenceId, ev);
            }
          }
        }
        onPhase?.({
          type: 'completed',
          phase: phaseId,
          label: this.completedLabelFor(step.label, result.value),
          result: { value: result.value },
        });
        this.recordTrace(ctx, `command.${step.label}.completed`, {
          summary: this.completedLabelFor(step.label, result.value),
          payload: { value: result.value },
        });
      }

      // ------- answer round -------
      const finalCityCountry = this.formatCityCountry(location);

      onPhase?.({
        type: 'started',
        phase: 'answer.streaming',
        label: thinkingForAnswer
          ? 'Thinking and drafting answer'
          : 'Drafting answer',
      });
      this.recordTrace(ctx, 'answer.streaming.started', {
        summary: `Streaming final answer (thinking=${thinkingForAnswer}).`,
      });

      const fragmentedContext = this.fragmenterReader.load({
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        personaName: ctx.personaName,
      });

      const answerMessages = buildAnswerPrompt({
        userText: ctx.userText,
        cityCountry: finalCityCountry,
        dateTime,
        fulfilledContext: this.renderFulfilledBlock(fulfilled),
        history: this.toHistoryTurns(ctx.history),
        personaSystemPrompt: ctx.personaSystemPrompt,
        fragmentedContext,
      });

      const finalCap = this.capping.forFinalAnswer({ messages: answerMessages });
      const finalOllama: Record<string, unknown> = {};
      if (finalCap !== undefined) finalOllama.num_predict = finalCap;

      const finalResult = await this.llm.streamInfer({
        correlationId: ctx.correlationId,
        messages: answerMessages,
        ...(ctx.llmParts.length > 0 ? { parts: ctx.llmParts } : {}),
        options: {
          responseFormat: 'text',
          thinking: thinkingForAnswer,
          ...(Object.keys(finalOllama).length > 0 ? { ollama: finalOllama } : {}),
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
        phase: 'answer.streaming',
        label: 'Answer streamed',
        result: { finishReason: finalResult.finishReason },
      });
      this.recordTrace(ctx, 'answer.streaming.completed', {
        summary: `Streaming answer completed with finishReason=${finalResult.finishReason}.`,
        payload: {
          finishReason: finalResult.finishReason,
          textLength: finalResult.text.length,
        },
      });

      if (finalResult.text.length === 0) {
        throw new ServiceUnavailableException(
          'Reverse-control flow produced an empty answer',
        );
      }

      const persisted = this.sessions.appendTurn({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        parts: input.dto.message.parts,
        userText: ctx.userText,
        occurredAt: ctx.occurredAt,
        assistantText: finalResult.text,
      });

      this.fragmenter.notifyObserved({
        sessionId: ctx.sessionId,
        lastTurnId: persisted.turnId,
        lastSeq: persisted.lastSeq,
        observedAt: persisted.createdAt,
      });

      const includeDiagnostics = input.dto.options?.includeDiagnostics === true;

      const citations = [...evidenceById.values()].map((ev) => ({
        evidenceId: ev.evidenceId,
        sourceTitle: ev.sourceTitle,
        ...(ev.sourceUrl ? { sourceUrl: ev.sourceUrl } : {}),
      }));

      return {
        sessionId: ctx.sessionId,
        turnId: persisted.turnId,
        assistantMessage: {
          messageId: persisted.assistantMessageId,
          content: finalResult.text,
          createdAt: persisted.createdAt,
        },
        finishReason: finalResult.finishReason,
        citations,
        ...(includeDiagnostics
          ? {
              diagnostics: {
                commands: [...parsed.commands],
                thinkingUsed: thinkingForAnswer,
              },
            }
          : {}),
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'Reverse-control flow failed',
      );
    }
  }

  // ----- helpers -----

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
      userId: session.userId,
      personaName: session.personaName,
      personaSystemPrompt: session.personaSystemPrompt,
      history: view.messages,
      llmParts,
      initialLocation,
      occurredAt: input.dto.message.occurredAt,
    };
  }

  private formatCityCountry(loc: UserLocation | undefined): string | null {
    if (!loc) return null;
    if (loc.cityName && loc.countryName) {
      return `${loc.cityName}, ${loc.countryName}`;
    }
    if (loc.cityName) return loc.cityName;
    return null;
  }

  private formatDateTime(occurredAt: string): string {
    const d = new Date(occurredAt);
    if (Number.isNaN(d.getTime())) return occurredAt;
    const date = d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const time = d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date}, ${time}`;
  }

  private planFulfillment(parsed: ParsedCommands): { label: CommandKind }[] {
    const steps: { label: CommandKind }[] = [];
    const hasPrompt = !!parsed.searchPrompt;

    // LOCATION/DATE_TIME with a search_prompt → labelled search.
    // Without a prompt → skip (already pre-injected in the meta-section).
    if (parsed.commands.has('LOCATION') && hasPrompt) {
      steps.push({ label: 'LOCATION' });
    }
    if (parsed.commands.has('DATE_TIME') && hasPrompt) {
      steps.push({ label: 'DATE_TIME' });
    }
    if (parsed.commands.has('SEARCH')) {
      steps.push({ label: 'SEARCH' });
    } else if (
      hasPrompt &&
      !parsed.commands.has('LOCATION') &&
      !parsed.commands.has('DATE_TIME')
    ) {
      // Bare [search_prompt="..."] without an accompanying command label
      // — treat as SEARCH so the prompt isn't lost.
      steps.push({ label: 'SEARCH' });
    }
    return steps;
  }

  private renderFulfilledBlock(fulfilled: FulfilledLine[]): string | null {
    if (fulfilled.length === 0) return null;
    return fulfilled.map((f) => `- ${f.command}: ${f.value}`).join('\n');
  }

  private toHistoryTurns(history: ConversationMessage[]): HistoryTurn[] {
    return history
      .slice(-RECENT_HISTORY_LIMIT)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }

  /**
   * Rough char-based token estimate. We're not metering tokens for
   * billing — just sizing a prompt budget — so a heuristic beats
   * adding a tokenizer dependency for ~10% better accuracy. ~3.5
   * chars/token is reasonable for our English + Romanian mix and
   * leans toward overestimation, which keeps the budget conservative.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  private renderHistoryBlock(history: ConversationMessage[]): string | null {
    // Walk newest → oldest, including messages while the running
    // token total stays under CLASSIFIER_HISTORY_TOKEN_BUDGET. The
    // most recent message is always included even if it alone
    // overshoots — skipping it would defeat the purpose.
    // Labels use "User:" / "You:" so the chatbot reading this history
    // sees its own past responses as belonging to itself, not to some
    // anonymous "ASSISTANT" entity.
    const eligible = history.filter((m) => m.role !== 'system');
    const picked: ConversationMessage[] = [];
    let totalTokens = 0;
    for (let i = eligible.length - 1; i >= 0; i--) {
      const m = eligible[i];
      const label = m.role === 'user' ? 'User' : 'You';
      const lineTokens = this.estimateTokens(
        `${label}: ${m.content}`,
      );
      if (
        picked.length > 0 &&
        totalTokens + lineTokens > CLASSIFIER_HISTORY_TOKEN_BUDGET
      ) {
        break;
      }
      picked.unshift(m);
      totalTokens += lineTokens;
    }
    if (picked.length === 0) return null;
    return picked
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
      .join('\n');
  }

  private summariseParsed(parsed: ParsedCommands): string {
    if (parsed.commands.size === 0) {
      return 'No command parsed; treating as DIRECT';
    }
    const list = [...parsed.commands].join(', ');
    if (parsed.searchPrompt) {
      return `Commands: ${list}; search_prompt="${parsed.searchPrompt}"`;
    }
    return `Commands: ${list}`;
  }

  private startedLabelFor(cmd: CommandKind, parsed: ParsedCommands): string {
    if (cmd === 'SEARCH') {
      return parsed.searchPrompt
        ? `Searching: "${parsed.searchPrompt}"`
        : 'Searching';
    }
    if (cmd === 'LOCATION') return 'Resolving location';
    if (cmd === 'DATE_TIME') return 'Looking up date and time';
    return `Fulfilling ${cmd}`;
  }

  private completedLabelFor(cmd: CommandKind, value: string): string {
    if (!value) return `${cmd} → (flag)`;
    const truncated = value.length > 80 ? `${value.slice(0, 77)}...` : value;
    return `${cmd} → ${truncated.replace(/\s+/g, ' ')}`;
  }

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
