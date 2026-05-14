/**
 * Rough char-based token estimate, shared across the orchestrator.
 *
 * ~3.5 chars/token is a reasonable upper bound for the English +
 * Romanian mix we serve. We're not metering tokens for billing —
 * just sizing prompt budgets — so a heuristic beats adding a real
 * tokenizer dependency. The estimate leans toward overestimation,
 * which keeps budgets conservative (we'd rather drop a few older
 * messages than overshoot the model's context window).
 *
 * Used by:
 * - ChatSessionService.appendTurn (incrementing
 *   sessions.total_token_count on each persisted turn).
 * - The flow service's classifier-history budget (older code,
 *   pre-Unit-J).
 * - buildAnswerPrompt's budget-driven history walk (Unit J).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
