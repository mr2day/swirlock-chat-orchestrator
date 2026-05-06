import { Inject, Injectable, Logger } from '@nestjs/common';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';
import { LlmHostService } from '../llm-host/llm-host.service';
import type { RagAllowedMode, RagFreshness, RagHint } from '../rag/rag.service';
import type { ConversationMessage } from './turn-planner.service';
import type {
  StandardAnswerKey,
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
  'standard_answer',
  'final_answer',
  'retrieve',
  'retrieve_and_think',
  'think',
  'clarify',
];

const STANDARD_ANSWER_KEYS: StandardAnswerKey[] = [
  'greeting',
  'status_check',
  'acknowledgement',
  'thanks',
  'goodbye',
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

const TURN_CATEGORIES = [
  'pure_greeting',
  'social_status',
  'acknowledgement',
  'thanks',
  'goodbye',
  'assistant_identity',
  'assistant_capability',
  'content_request',
  'factual_question',
  'coding_request',
  'other',
] as const;

type TurnCategory = (typeof TURN_CATEGORIES)[number];

const STANDARD_CATEGORY_BY_KEY: Record<
  Exclude<StandardAnswerKey, 'clarify'>,
  TurnCategory
> = {
  greeting: 'pure_greeting',
  status_check: 'social_status',
  acknowledgement: 'acknowledgement',
  thanks: 'thanks',
  goodbye: 'goodbye',
};

@Injectable()
export class UtilityTurnClassifierService {
  private readonly log = new Logger(UtilityTurnClassifierService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly llm: LlmHostService,
  ) {}

  async classify(input: ClassifyTurnInput): Promise<UtilityTurnDecision> {
    try {
      const result = await this.llm.infer({
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
      content: this.limitText(message.content, 500),
      createdAt: message.created_at,
    }));

    return [
      'You are the Swirlock turn-routing Utility LLM.',
      'This is an internal orchestration call, not a chat reply. Return only valid JSON.',
      'Your job is to classify the user turn before any retrieval, memory prompt assembly, or final-answer generation.',
      '',
      'Allowed routes:',
      '- standard_answer: code should answer from a standardized answer table. No retrieval. No final-answer LLM. No thinking.',
      '- final_answer: final-answer LLM should answer without retrieval and without thinking.',
      '- retrieve: RAG should gather evidence, then final-answer LLM should answer without thinking.',
      '- retrieve_and_think: RAG should gather evidence, then final-answer LLM may use thinking.',
      '- think: final-answer LLM should use thinking without retrieval.',
      '- clarify: final-answer LLM should ask a targeted clarification. No retrieval. No thinking.',
      '',
      'Standard answer keys:',
      '- greeting: the user only greets or opens the conversation.',
      '- status_check: the user asks how the assistant is, whether it is okay, or asks a similar social status question.',
      '- acknowledgement: the user acknowledges or confirms something without asking a new question.',
      '- thanks: the user thanks the assistant.',
      '- goodbye: the user ends the conversation.',
      '- clarify is not a standardized answer key.',
      '',
      'Routing requirements:',
      '- Classify the meaning of the message across languages, not only English surface words.',
      '- Choose standard_answer for casual greetings, social check-ins, acknowledgements, thanks, and goodbyes.',
      '- For "how are you" style social check-ins, choose standardAnswerKey=status_check, not greeting.',
      '- The standardized answer table is English-only; choose standard_answer only when the user message is primarily English.',
      '- Do not choose standard_answer for content-bearing questions, even when they are socially phrased.',
      '- Questions about the assistant name, identity, model, persona, or capabilities are content-bearing assistant_identity or assistant_capability turns; choose final_answer.',
      '- Example: Romanian "cum te cheama" means "what is your name"; route final_answer with turnCategory=assistant_identity and userLanguage=ro.',
      '- Choose retrieval only when external evidence or current factual data is needed for a good answer.',
      '- Choose thinking only when the turn needs multi-step reasoning, planning, debugging, comparison, or synthesis.',
      '- Do not choose clarify for requests that can be answered with a reasonable assumption or a generic example.',
      '- Requests asking for "some", "an example", or "from your own knowledge" are sufficiently specified; choose final_answer or think unless external evidence is required.',
      '- For standard_answer, set includeMemoryInPrompt=false and includeRecentConversationInPrompt=false.',
      '- For retrieve routes, rewrite resolvedQueryText into a self-contained search query using recent conversation only when needed.',
      '- Use only allowed retrieval modes from this deployment.',
      '',
      'Return this JSON object shape:',
      JSON.stringify({
        route: 'standard_answer',
        standardAnswerKey: 'status_check',
        turnCategory: 'social_status',
        userLanguage: 'en',
        resolvedQueryText: 'original or rewritten user query',
        intent: 'brief intent label',
        freshness: input.defaultFreshness,
        allowedModes: input.defaultAllowedModes,
        hints: [{ kind: 'time_reference', text: 'optional hint' }],
        includeMemoryInPrompt: false,
        includeRecentConversationInPrompt: false,
        confidence: 'high',
        reason: 'short operational reason',
      }),
      '',
      `Current client timestamp: ${input.occurredAt}`,
      `Default retrieval freshness: ${input.defaultFreshness}`,
      `Allowed retrieval modes: ${allowedModes}`,
      '',
      'Recent conversation JSON:',
      JSON.stringify(recent),
      '',
      'Current user message:',
      input.userText,
    ].join('\n');
  }

  private normalizeDecision(
    rawText: string,
    input: ClassifyTurnInput,
  ): UtilityTurnDecision {
    const parsed = this.parseJsonObject(rawText);
    if (!parsed) return this.fallbackDecision(input);

    let route = this.pickEnum(parsed.route, ROUTES, 'final_answer');
    const standardAnswerKey = this.pickOptionalEnum(
      parsed.standardAnswerKey,
      STANDARD_ANSWER_KEYS,
    );
    const turnCategory = this.pickEnum(
      parsed.turnCategory,
      TURN_CATEGORIES,
      'other',
    );
    const userLanguage = this.limitText(
      this.stringValue(parsed.userLanguage, 'unknown').toLowerCase(),
      20,
    );
    if (
      route === 'standard_answer' &&
      (!standardAnswerKey ||
        !this.canUseStandardAnswer(
          standardAnswerKey,
          turnCategory,
          userLanguage,
        ))
    ) {
      route = 'final_answer';
    }
    const shouldRetrieve =
      route === 'retrieve' || route === 'retrieve_and_think';
    const shouldThink = route === 'think' || route === 'retrieve_and_think';
    const directRoute = route === 'standard_answer';
    const resolvedQueryText = this.stringValue(
      parsed.resolvedQueryText,
      input.userText,
    );

    return {
      route,
      ...(directRoute
        ? {
            standardAnswerKey,
          }
        : {}),
      shouldRetrieve,
      shouldThink,
      includeMemoryInPrompt: directRoute
        ? false
        : this.booleanValue(parsed.includeMemoryInPrompt, true),
      includeRecentConversationInPrompt: directRoute
        ? false
        : this.booleanValue(parsed.includeRecentConversationInPrompt, true),
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

  private pickOptionalEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
  ): T | undefined {
    return typeof value === 'string' && allowed.includes(value as T)
      ? (value as T)
      : undefined;
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

  private canUseStandardAnswer(
    key: StandardAnswerKey,
    turnCategory: TurnCategory,
    userLanguage: string,
  ): key is Exclude<StandardAnswerKey, 'clarify'> {
    if (key === 'clarify') return false;
    if (!this.isEnglishLanguage(userLanguage)) return false;
    return STANDARD_CATEGORY_BY_KEY[key] === turnCategory;
  }

  private isEnglishLanguage(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return normalized === 'en' || normalized.startsWith('en-');
  }

  private limitText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }
}
