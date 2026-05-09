import { Injectable, Logger } from '@nestjs/common';
import { LlmHostService } from '../../llm-host/llm-host.service';
import type {
  LlmInferOptions,
  LlmMessage,
} from '../../llm-host/llm-host.service';
import { CappingService } from '../capping/capping.service';
import {
  buildGenerateSearchQueryPrompt,
  buildNeedsLocationPrompt,
  buildNeedsSearchPrompt,
} from './decision-prompts';
import { parseFlag, parsePayload } from './signal-codec';

export type PhaseEvent =
  | { type: 'started'; phase: string; label: string }
  | { type: 'token'; phase: string; text: string }
  | {
      type: 'completed';
      phase: string;
      label?: string;
      result?: unknown;
    }
  | { type: 'failed'; phase: string; message: string };

export type PhaseEventEmitter = (event: PhaseEvent) => void;

export interface DecisionCallContext {
  correlationId: string;
  abortSignal?: AbortSignal;
  onPhase?: PhaseEventEmitter;
}

export interface NeedsSearchInput extends DecisionCallContext {
  userText: string;
}

export interface NeedsLocationInput extends DecisionCallContext {
  userText: string;
}

export interface GenerateSearchQueryInput extends DecisionCallContext {
  userText: string;
  location?: { cityName?: string; countryName?: string };
}

/**
 * The orchestrator's oracle layer.
 *
 * Each method asks the Vanamonde LLM exactly one short utilitarian
 * question and returns a typed value. Per `DECISION_PIPELINE.md`:
 *
 * - Every call streams. Tokens are forwarded to `onPhase` as `token`
 *   events so the UI can render the model's raw output (including
 *   the `⟦…⟧` markers) live.
 * - No `max_tokens` and no safety timeouts. The Vanamonde LLM is
 *   left free; future capping is documented in `CAPPING.md` and
 *   plumbed through `CappingService`.
 * - Parse failure logs once and falls back to a safe default for
 *   the decision in question.
 *
 * Prompt strings live in `decision-prompts.ts`, never inlined here.
 * Signal parsing lives in `signal-codec.ts`, never inlined here.
 */
@Injectable()
export class DecisionsService {
  private readonly log = new Logger(DecisionsService.name);

  constructor(
    private readonly llm: LlmHostService,
    private readonly capping: CappingService,
  ) {}

  /** Should the orchestrator search before answering? */
  async needsSearch(input: NeedsSearchInput): Promise<boolean> {
    const phase = 'decision.needsSearch';
    const messages = buildNeedsSearchPrompt(input.userText);
    const result = await this.runUtilitarian({
      phase,
      label: 'Checking if search is needed',
      messages,
      ctx: input,
    });
    if (result.kind === 'failed') return false;
    const flag = parseFlag(result.text);
    if (flag?.key === 'action' && flag.value.toLowerCase() === 'search') {
      input.onPhase?.({
        type: 'completed',
        phase,
        label: 'Search needed',
        result: 'search',
      });
      return true;
    }
    if (flag?.key === 'action' && flag.value.toLowerCase() === 'direct') {
      input.onPhase?.({
        type: 'completed',
        phase,
        label: 'Direct answer',
        result: 'direct',
      });
      return false;
    }
    this.log.warn(
      `needsSearch could not parse signal from output: ${this.preview(result.text)}; defaulting to direct.`,
    );
    input.onPhase?.({
      type: 'failed',
      phase,
      message: 'Could not parse signal; defaulting to direct.',
    });
    return false;
  }

  /** Does an accurate answer require the user's real-world location? */
  async needsLocation(input: NeedsLocationInput): Promise<boolean> {
    const phase = 'decision.needsLocation';
    const messages = buildNeedsLocationPrompt(input.userText);
    const result = await this.runUtilitarian({
      phase,
      label: 'Checking if location is needed',
      messages,
      ctx: input,
    });
    if (result.kind === 'failed') return false;
    const flag = parseFlag(result.text);
    if (flag?.key === 'location' && flag.value.toLowerCase() === 'needed') {
      input.onPhase?.({
        type: 'completed',
        phase,
        label: 'Location needed',
        result: 'needed',
      });
      return true;
    }
    if (flag?.key === 'location' && flag.value.toLowerCase() === 'skip') {
      input.onPhase?.({
        type: 'completed',
        phase,
        label: 'Location not needed',
        result: 'skip',
      });
      return false;
    }
    this.log.warn(
      `needsLocation could not parse signal from output: ${this.preview(result.text)}; defaulting to skip.`,
    );
    input.onPhase?.({
      type: 'failed',
      phase,
      message: 'Could not parse signal; defaulting to skip.',
    });
    return false;
  }

  /**
   * Rewrite the user prompt as a self-contained search query, with
   * the user's city name baked in when location is known.
   *
   * Falls back to the raw `userText` on parse failure.
   */
  async generateSearchQuery(input: GenerateSearchQueryInput): Promise<string> {
    const phase = 'decision.generateSearchQuery';
    const messages = buildGenerateSearchQueryPrompt(
      input.userText,
      input.location,
    );
    const result = await this.runUtilitarian({
      phase,
      label: 'Composing search query',
      messages,
      ctx: input,
    });
    if (result.kind === 'failed') return input.userText;
    const payload = parsePayload(result.text);
    if (payload?.key === 'query' && payload.value.trim().length > 0) {
      const query = payload.value.trim();
      input.onPhase?.({
        type: 'completed',
        phase,
        label: `Search query: ${query}`,
        result: query,
      });
      return query;
    }
    this.log.warn(
      `generateSearchQuery could not parse query from output: ${this.preview(result.text)}; falling back to userText.`,
    );
    input.onPhase?.({
      type: 'failed',
      phase,
      message: 'Could not parse signal; using user text as query.',
    });
    return input.userText;
  }

  // ----- internal -----

  private async runUtilitarian(args: {
    phase: string;
    label: string;
    messages: LlmMessage[];
    ctx: DecisionCallContext;
  }): Promise<{ kind: 'ok'; text: string } | { kind: 'failed' }> {
    args.ctx.onPhase?.({
      type: 'started',
      phase: args.phase,
      label: args.label,
    });

    const cap = this.capping.forUtilitarianDecision({
      messages: args.messages,
    });
    const ollama: Record<string, unknown> = { temperature: 0 };
    if (cap !== undefined) ollama.num_predict = cap;

    const options: LlmInferOptions = {
      responseFormat: 'text',
      thinking: false,
      ollama,
    };

    try {
      const result = await this.llm.streamInfer({
        correlationId: args.ctx.correlationId,
        messages: args.messages,
        options,
        ...(args.ctx.abortSignal ? { abortSignal: args.ctx.abortSignal } : {}),
        onEvent: (evt) => {
          if (evt.type === 'chunk' && evt.payload.text) {
            args.ctx.onPhase?.({
              type: 'token',
              phase: args.phase,
              text: evt.payload.text,
            });
          }
        },
      });
      return { kind: 'ok', text: result.text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`utilitarian call ${args.phase} failed: ${message}`);
      args.ctx.onPhase?.({
        type: 'failed',
        phase: args.phase,
        message,
      });
      return { kind: 'failed' };
    }
  }

  private preview(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact.length <= 200) return compact;
    return `${compact.slice(0, 197)}...`;
  }
}
