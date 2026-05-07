import type { RagAllowedMode, RagFreshness, RagHint } from '../rag/rag.service';

export type TurnRoute =
  | 'final_answer'
  | 'retrieve'
  | 'retrieve_and_think'
  | 'think'
  | 'clarify';

export type TurnDecisionConfidence = 'low' | 'medium' | 'high';

export interface UtilityTurnDecision {
  route: TurnRoute;
  shouldRetrieve: boolean;
  shouldThink: boolean;
  includeMemoryInPrompt: boolean;
  includeRecentConversationInPrompt: boolean;
  resolvedQueryText: string;
  intent: string;
  freshness: RagFreshness;
  allowedModes: RagAllowedMode[];
  hints: RagHint[];
  requiresLocation: boolean;
  confidence: TurnDecisionConfidence;
  reason: string;
}
