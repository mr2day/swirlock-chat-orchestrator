import type { RagAllowedMode, RagFreshness, RagHint } from '../rag/rag.service';

export type TurnRoute =
  | 'standard_answer'
  | 'final_answer'
  | 'retrieve'
  | 'retrieve_and_think'
  | 'think'
  | 'clarify';

export type StandardAnswerKey =
  | 'greeting'
  | 'status_check'
  | 'acknowledgement'
  | 'thanks'
  | 'goodbye'
  | 'clarify';

export type TurnDecisionConfidence = 'low' | 'medium' | 'high';

export interface UtilityTurnDecision {
  route: TurnRoute;
  standardAnswerKey?: StandardAnswerKey;
  shouldRetrieve: boolean;
  shouldThink: boolean;
  includeMemoryInPrompt: boolean;
  includeRecentConversationInPrompt: boolean;
  resolvedQueryText: string;
  intent: string;
  freshness: RagFreshness;
  allowedModes: RagAllowedMode[];
  hints: RagHint[];
  confidence: TurnDecisionConfidence;
  reason: string;
}
