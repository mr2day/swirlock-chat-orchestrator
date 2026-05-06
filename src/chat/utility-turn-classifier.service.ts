import { Inject, Injectable, Logger } from '@nestjs/common';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';
import { LlmHostService } from '../llm-host/llm-host.service';
import type { RagAllowedMode, RagFreshness, RagHint } from '../rag/rag.service';
import type { ConversationMessage } from './turn-planner.service';
import type {
  TurnDecisionConfidence,
  TurnRoute,
  UtilityTurnDecision,
} from './turn-classification';

export interface ClassifyTurnInput {
  correlationId: string;
  userText: string;
  occurredAt: string;
  history: ConversationMessage[];
  defaultFreshness: RagFreshness;
  defaultAllowedModes: RagAllowedMode[];
  abortSignal?: AbortSignal;
}

const ROUTES: TurnRoute[] = [
  'final_answer',
  'retrieve',
  'retrieve_and_think',
  'think',
  'clarify',
];

const FRESHNESS_VALUES: RagFreshness[] = ['low', 'medium', 'high', 'realtime'];
const CONFIDENCE_VALUES: TurnDecisionConfidence[] = ['low', 'medium', 'high'];
const HINT_KINDS: RagHint['kind'][] = [
  'entity',
  'time_reference',
  'preference',
  'disambiguation',
  'constraint',
];

@Injectable()
export class UtilityTurnClassifierService {
  private readonly log = new Logger(UtilityTurnClassifierService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly llm: LlmHostService,
  ) {}

  async classify(input: ClassifyTurnInput): Promise<UtilityTurnDecision> {
    try {
      const result = await this.llm.streamInfer({
        correlationId: input.correlationId,
        baseUrl: this.utilityBaseUrl(),
        callerService: this.utilityCallerService(),
        timeoutMs: this.utilityTimeoutMs(),
        priority: this.utilityPriority(),
        parts: [{ type: 'text', text: this.buildPrompt(input) }],
        options: {
          responseFormat: 'json',
          thinking: false,
          ollama: { temperature: 0 },
        },
        abortSignal: input.abortSignal,
      });

      return this.normalizeDecision(result.text, input);
    } catch (error) {
      this.log.warn(
        `[${input.correlationId}] Utility turn classifier unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.fallbackDecision(input);
    }
  }

  private buildPrompt(input: ClassifyTurnInput): string {
    const allowedModes = input.defaultAllowedModes.join(', ') || '(none)';
    const recent = input.history.slice(-8).map((message) => ({
      role: message.role,
      content: this.limitText(message.content, 220),
      createdAt: message.created_at,
    }));

    return [
      'Classify this user turn for Swirlock orchestration.',
      'Return compact JSON only. No prose. Do not answer the user.',
      'Do not use word matching; classify meaning across languages.',
      'Allowed route values: final_answer, retrieve, retrieve_and_think, think, clarify.',
      'Set shouldRetrieve/shouldThink consistently with route.',
      'Use retrieval only for external evidence/current facts. Use thinking only for multi-step reasoning/debugging/synthesis.',
      'For greetings, thanks, acknowledgements, social check-ins, jokes, assistant identity, and ordinary chat: final_answer with no retrieval and no thinking.',
      'For underspecified requests that truly cannot proceed: clarify with no retrieval and no thinking.',
      'If retrieval is needed, resolvedQueryText must be a self-contained query using recent conversation only when needed.',
      `Current timestamp: ${input.occurredAt}`,
      `Default freshness: ${input.defaultFreshness}`,
      `Allowed retrieval modes: ${allowedModes}`,
      `Recent conversation JSON: ${JSON.stringify(recent)}`,
      `User message: ${input.userText}`,
      'JSON schema example:',
      JSON.stringify({
        route: 'final_answer',
        shouldRetrieve: false,
        shouldThink: false,
        includeMemoryInPrompt: false,
        includeRecentConversationInPrompt: false,
        resolvedQueryText: input.userText,
        intent: 'greeting',
        freshness: input.defaultFreshness,
        confidence: 'high',
        reason: 'short routing reason',
      }),
    ].join('\n');
  }

  private normalizeDecision(
    rawText: string,
    input: ClassifyTurnInput,
  ): UtilityTurnDecision {
    const parsed = this.parseJsonObject(rawText);
    if (!parsed) return this.fallbackDecision(input);

    let route = this.pickEnum(parsed.route, ROUTES, 'final_answer');
    let shouldRetrieve = this.booleanValue(
      parsed.shouldRetrieve,
      route === 'retrieve' || route === 'retrieve_and_think',
    );
    let shouldThink = this.booleanValue(
      parsed.shouldThink,
      route === 'think' || route === 'retrieve_and_think',
    );
    if (route === 'clarify') {
      shouldRetrieve = false;
      shouldThink = false;
    } else if (shouldRetrieve && shouldThink) {
      route = 'retrieve_and_think';
    } else if (shouldRetrieve) {
      route = 'retrieve';
    } else if (shouldThink) {
      route = 'think';
    } else {
      route = 'final_answer';
    }
    const resolvedQueryText = this.stringValue(
      parsed.resolvedQueryText,
      input.userText,
    );

    return {
      route,
      shouldRetrieve,
      shouldThink,
      includeMemoryInPrompt: this.booleanValue(
        parsed.includeMemoryInPrompt,
        true,
      ),
      includeRecentConversationInPrompt: this.booleanValue(
        parsed.includeRecentConversationInPrompt,
        true,
      ),
      resolvedQueryText,
      intent: this.limitText(this.stringValue(parsed.intent, 'general'), 80),
      freshness: this.pickEnum(
        parsed.freshness,
        FRESHNESS_VALUES,
        input.defaultFreshness,
      ),
      allowedModes: shouldRetrieve
        ? this.allowedModes(parsed.allowedModes, input.defaultAllowedModes)
        : [],
      hints: shouldRetrieve ? this.hints(parsed.hints) : [],
      confidence: this.pickEnum(parsed.confidence, CONFIDENCE_VALUES, 'medium'),
      reason: this.limitText(
        this.stringValue(parsed.reason, 'Utility classifier selected route.'),
        240,
      ),
    };
  }

  private fallbackDecision(input: ClassifyTurnInput): UtilityTurnDecision {
    return {
      route: 'final_answer',
      shouldRetrieve: false,
      shouldThink: false,
      includeMemoryInPrompt: true,
      includeRecentConversationInPrompt: true,
      resolvedQueryText: input.userText,
      intent: 'general',
      freshness: input.defaultFreshness,
      allowedModes: [],
      hints: [],
      confidence: 'low',
      reason:
        'Utility classifier failed or returned invalid JSON; using final answer without retrieval or thinking.',
    };
  }

  private parseJsonObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (this.isRecord(parsed)) return parsed;
    } catch {
      const match = value.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const parsed = JSON.parse(match[0]) as unknown;
        if (this.isRecord(parsed)) return parsed;
      } catch {
        return null;
      }
    }

    return null;
  }

  private allowedModes(
    value: unknown,
    defaults: RagAllowedMode[],
  ): RagAllowedMode[] {
    if (!Array.isArray(value)) return [...defaults];
    const out = value.filter(
      (mode): mode is RagAllowedMode =>
        (mode === 'local_rag' || mode === 'live_web') &&
        defaults.includes(mode),
    );
    return out.length > 0 ? out : [...defaults];
  }

  private hints(value: unknown): RagHint[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is Record<string, unknown> => this.isRecord(item))
      .map((item) => ({
        kind: this.pickEnum(item.kind, HINT_KINDS, 'constraint'),
        text: this.limitText(this.stringValue(item.text, ''), 240),
      }))
      .filter((hint) => hint.text.length > 0)
      .slice(0, 8);
  }

  private pickEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
  ): T {
    return typeof value === 'string' && allowed.includes(value as T)
      ? (value as T)
      : fallback;
  }

  private stringValue(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  private booleanValue(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private utilityBaseUrl(): string {
    return this.cfg.utilityLlmHost?.baseUrl ?? this.cfg.llmHost.baseUrl;
  }

  private utilityCallerService(): string {
    return (
      this.cfg.utilityLlmHost?.callerService ??
      `${this.cfg.llmHost.callerService}:turn-classifier`
    );
  }

  private utilityTimeoutMs(): number {
    return this.cfg.utilityLlmHost?.timeoutMs ?? this.cfg.llmHost.timeoutMs;
  }

  private utilityPriority(): number | undefined {
    return this.cfg.utilityLlmHost?.priority;
  }

  private limitText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }
}
