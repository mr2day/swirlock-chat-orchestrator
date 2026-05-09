import { Injectable } from '@nestjs/common';
import type { LlmMessage } from '../../llm-host/llm-host.service';

/**
 * Owns ALL output-cap policy for the orchestrator.
 *
 * Today every method returns `undefined` (no cap). The Vanamonde LLM
 * is left free per current architectural decision; see
 * [`CAPPING.md`](../../../CAPPING.md) for the rationale, the future
 * input-proportional capping strategy, and the do-not-remove rule.
 *
 * **DO NOT remove or inline these methods.** Flow services and
 * `DecisionsService` thread every LLM-call site through
 * `CappingService` deliberately, so flipping caps on later is a
 * one-line change here. A method returning `undefined` is not dead
 * code; it is a load-bearing hook.
 */
@Injectable()
export class CappingService {
  /**
   * Cap for utilitarian decision calls (`DecisionsService` methods:
   * `needsSearch`, `generateSearchQuery`, etc.).
   *
   * Today: returns `undefined` (no cap).
   *
   * Future: input-proportional cap — bound the model's output to
   * `inputTokens(messages) + margin` so runaway hallucinations or
   * looping behaviour can be detected and stopped. Output exceeding
   * input on a utilitarian call is itself the misbehavior signal.
   */
  forUtilitarianDecision(_input: {
    messages: LlmMessage[];
  }): number | undefined {
    return undefined;
  }

  /**
   * Cap for the streaming final-answer call.
   *
   * Always returns `undefined`. The final answer is by design
   * free-breathing and routinely much larger than the question.
   * The hook exists so future strategies (e.g. wall-clock budgets
   * for embodied surfaces) can be flipped on here without touching
   * the conversation flow.
   */
  forFinalAnswer(_input: { messages: LlmMessage[] }): number | undefined {
    return undefined;
  }
}
