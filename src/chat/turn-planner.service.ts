import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { RagAllowedMode, RagFreshness, RagHint } from '../rag/rag.service';
import type { TurnRoute } from './turn-classification';
import { UtilityTurnClassifierService } from './utility-turn-classifier.service';

export interface ConversationMessage {
  id: string;
  turn_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

export interface ContextMemoryFragment {
  fragmentId: string;
  memoryClass: 'short_term' | 'long_term' | 'user_identity' | 'app_identity';
  importance: 'critical' | 'high' | 'medium' | 'low';
  content: string;
  sourceTurnIds?: string[];
  updatedAt: string;
}

export interface TurnPlan {
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
  memoryFragments: ContextMemoryFragment[];
  requiresLocation: boolean;
  planReason: string;
}

export interface PlanTurnInput {
  correlationId: string;
  userText: string;
  occurredAt: string;
  history: ConversationMessage[];
  defaultFreshness: RagFreshness;
  defaultAllowedModes: RagAllowedMode[];
  abortSignal?: AbortSignal;
}

@Injectable()
export class TurnPlannerService {
  constructor(private readonly classifier: UtilityTurnClassifierService) {}

  async plan(input: PlanTurnInput): Promise<TurnPlan> {
    const userText = input.userText.trim();
    const decision = await this.classifier.classify({
      ...input,
      userText,
    });
    const memoryFragments =
      decision.includeMemoryInPrompt ||
      decision.includeRecentConversationInPrompt
        ? this.buildMemoryFragments(input)
        : [];

    return {
      route: decision.route,
      shouldRetrieve: decision.shouldRetrieve,
      shouldThink: decision.shouldThink,
      includeMemoryInPrompt: decision.includeMemoryInPrompt,
      includeRecentConversationInPrompt:
        decision.includeRecentConversationInPrompt,
      resolvedQueryText: decision.resolvedQueryText,
      intent: decision.intent,
      freshness: decision.freshness,
      allowedModes: decision.shouldRetrieve ? decision.allowedModes : [],
      hints: decision.shouldRetrieve ? decision.hints : [],
      memoryFragments,
      requiresLocation: decision.requiresLocation,
      planReason: decision.reason,
    };
  }

  private buildMemoryFragments(input: PlanTurnInput): ContextMemoryFragment[] {
    const recent = input.history.slice(-6);
    if (recent.length === 0) return [];

    return [
      {
        fragmentId: randomUUID(),
        memoryClass: 'short_term',
        importance: 'medium',
        content: recent
          .map(
            (message) =>
              `${message.role}: ${this.limitText(message.content, 180)}`,
          )
          .join('\n'),
        sourceTurnIds: [...new Set(recent.map((message) => message.turn_id))],
        updatedAt: input.occurredAt,
      },
    ];
  }

  private limitText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }
}
