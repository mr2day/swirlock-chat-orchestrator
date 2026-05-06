import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { RagAllowedMode, RagFreshness, RagHint } from '../rag/rag.service';

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
  shouldRetrieve: boolean;
  resolvedQueryText: string;
  intent: string;
  freshness: RagFreshness;
  allowedModes: RagAllowedMode[];
  hints: RagHint[];
  memoryFragments: ContextMemoryFragment[];
  planReason: string;
}

export interface PlanTurnInput {
  userText: string;
  occurredAt: string;
  history: ConversationMessage[];
  defaultFreshness: RagFreshness;
  defaultAllowedModes: RagAllowedMode[];
}

const GREETING_OR_ACKNOWLEDGEMENT =
  /^(hi|hello|hey|salut|buna|good morning|good afternoon|good evening|thanks|thank you|ok|okay|cool|great|nice|yes|no)[\s!.?]*$/i;

const WEATHER_OR_TIME_SENSITIVE =
  /\b(weather|temperature|forecast|humidity|wind|right now|currently|now|today|tonight|live|latest|current)\b/i;

const MARKET_OR_SPORTS =
  /\b(price|quote|stock|crypto|bitcoin|btc|exchange rate|score|scores|result|game|match|live score)\b/i;

const QUESTION_START =
  /^(who|what|where|when|why|how|which|with whom|with which|can you tell me|tell me|do you know)\b/i;

const FOLLOW_UP_REFERENCE =
  /\b(he|him|his|she|her|they|them|their|it|its|that|those|same|the subject|the person|the movie|the film|the company)\b/i;

const COMMON_ENTITY_PREFIXES =
  /^(Who|What|Where|When|Why|How|Tell|Can|Could|Would|Please|The|A|An|This|That|With|Which|What About|And)\b/;

@Injectable()
export class TurnPlannerService {
  plan(input: PlanTurnInput): TurnPlan {
    const userText = input.userText.trim();
    const activeSubject = this.findActiveSubject(input.history);
    const memoryFragments = this.buildMemoryFragments(input, activeSubject);
    const hints = this.buildHints(input, activeSubject);
    const resolvedQueryText = this.resolveQueryText(userText, activeSubject);
    const shouldRetrieve = this.shouldRetrieve(userText, resolvedQueryText);
    const freshness = this.pickFreshness(userText, input.defaultFreshness);
    const intent = this.pickIntent(userText, resolvedQueryText, activeSubject);

    return {
      shouldRetrieve,
      resolvedQueryText,
      intent,
      freshness,
      allowedModes: shouldRetrieve ? input.defaultAllowedModes : [],
      hints: shouldRetrieve ? hints : [],
      memoryFragments,
      planReason: shouldRetrieve
        ? 'The turn appears to need external evidence or cached knowledge.'
        : 'The turn is conversational and does not need retrieval.',
    };
  }

  private shouldRetrieve(userText: string, resolvedQueryText: string): boolean {
    const normalized = userText.trim();
    if (!normalized) return false;
    if (GREETING_OR_ACKNOWLEDGEMENT.test(normalized)) return false;

    if (WEATHER_OR_TIME_SENSITIVE.test(normalized)) return true;
    if (MARKET_OR_SPORTS.test(normalized)) return true;
    if (QUESTION_START.test(normalized)) return true;

    return resolvedQueryText !== normalized && resolvedQueryText.length > 0;
  }

  private resolveQueryText(
    userText: string,
    activeSubject: string | null,
  ): string {
    if (!activeSubject || !this.isLikelyFollowUp(userText)) {
      return userText;
    }

    let resolved = userText
      .replace(/\bhe\b/gi, activeSubject)
      .replace(/\bhim\b/gi, activeSubject)
      .replace(/\bhis\b/gi, `${activeSubject}'s`)
      .replace(/\bshe\b/gi, activeSubject)
      .replace(/\bher\b/gi, activeSubject)
      .replace(/\bthey\b/gi, activeSubject)
      .replace(/\bthem\b/gi, activeSubject)
      .replace(/\btheir\b/gi, `${activeSubject}'s`);

    if (resolved === userText) {
      resolved = `${userText} Context: ${activeSubject}.`;
    }

    return resolved;
  }

  private isLikelyFollowUp(userText: string): boolean {
    if (this.extractNamedEntities(userText).length > 0) return false;
    if (FOLLOW_UP_REFERENCE.test(userText)) return true;
    return /^(and|also|what about|with which|which|how many|where did|when did)\b/i.test(
      userText.trim(),
    );
  }

  private pickFreshness(
    userText: string,
    defaultFreshness: RagFreshness,
  ): RagFreshness {
    if (
      /\b(right now|currently|live|current temperature|temperature.*now|weather.*now|score|price|quote)\b/i.test(
        userText,
      )
    ) {
      return 'realtime';
    }

    if (
      /\b(today|tonight|latest|recent|newest|breaking|this week)\b/i.test(
        userText,
      )
    ) {
      return 'high';
    }

    if (
      /^who (was|is)\b/i.test(userText) ||
      /\bbiography|born|died\b/i.test(userText)
    ) {
      return 'low';
    }

    return defaultFreshness;
  }

  private pickIntent(
    userText: string,
    resolvedQueryText: string,
    activeSubject: string | null,
  ): string {
    if (/\b(weather|temperature|forecast|humidity|wind)\b/i.test(userText)) {
      return 'current-weather';
    }
    if (
      /\b(price|quote|stock|crypto|bitcoin|btc|exchange rate)\b/i.test(userText)
    ) {
      return 'market-price';
    }
    if (/\b(score|scores|result|game|match|live score)\b/i.test(userText)) {
      return 'sports-score';
    }
    if (/^who (was|is)\b/i.test(resolvedQueryText)) {
      return 'biography';
    }
    if (activeSubject && resolvedQueryText !== userText) {
      return 'follow-up';
    }

    return 'general';
  }

  private buildHints(
    input: PlanTurnInput,
    activeSubject: string | null,
  ): RagHint[] {
    const hints: RagHint[] = [
      {
        kind: 'time_reference',
        text: `Client turn timestamp: ${input.occurredAt}`,
      },
    ];

    if (activeSubject && this.isLikelyFollowUp(input.userText)) {
      hints.push({
        kind: 'entity',
        text: `Active conversation subject: ${activeSubject}`,
      });
      hints.push({
        kind: 'disambiguation',
        text: `Resolve pronouns and elliptical references against ${activeSubject}.`,
      });
    }

    return hints;
  }

  private buildMemoryFragments(
    input: PlanTurnInput,
    activeSubject: string | null,
  ): ContextMemoryFragment[] {
    const fragments: ContextMemoryFragment[] = [];
    const recent = input.history.slice(-6);

    if (activeSubject) {
      const sourceTurnIds = recent
        .filter((message) => message.content.includes(activeSubject))
        .map((message) => message.turn_id);

      fragments.push({
        fragmentId: randomUUID(),
        memoryClass: 'short_term',
        importance: 'high',
        content: `Active conversation subject: ${activeSubject}.`,
        sourceTurnIds: [...new Set(sourceTurnIds)],
        updatedAt: input.occurredAt,
      });
    }

    if (recent.length > 0) {
      fragments.push({
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
      });
    }

    return fragments;
  }

  private findActiveSubject(history: ConversationMessage[]): string | null {
    for (const message of [...history].reverse()) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const entities = this.extractNamedEntities(message.content);
      if (entities.length > 0) {
        return entities[0];
      }
    }

    return null;
  }

  private extractNamedEntities(text: string): string[] {
    const candidates = text.match(
      /\b[A-Z][a-z]+(?:\s+(?:de|da|di|du|van|von|le|la|del|della|[A-Z][a-z]+)){1,4}\b/g,
    );
    if (!candidates) return [];

    return candidates
      .map((candidate) => candidate.trim())
      .filter((candidate) => !COMMON_ENTITY_PREFIXES.test(candidate))
      .filter(
        (candidate) =>
          !/\b(Question|Answer|Sources|Retrieved Evidence)\b/.test(candidate),
      );
  }

  private limitText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }
}
