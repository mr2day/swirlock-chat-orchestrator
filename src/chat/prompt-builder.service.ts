import { Injectable } from '@nestjs/common';
import type { LlmMessage } from '../llm-host/llm-host.service';
import type { RagContext, UserLocation } from '../rag/rag.service';
import type { PersonaIdentityCapsule } from './persona-identity.service';
import type {
  ContextMemoryFragment,
  ConversationMessage,
  TurnPlan,
} from './turn-planner.service';

export interface BuildPromptInput {
  history: ConversationMessage[];
  userText: string;
  occurredAt: string;
  turnPlan: TurnPlan;
  ragContext: RagContext;
  identity: PersonaIdentityCapsule;
  userLocation?: UserLocation;
}

@Injectable()
export class PromptBuilderService {
  buildMessages(input: BuildPromptInput): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: 'system', content: input.identity.coreMessage },
    ];

    if (input.identity.contextualMessage) {
      messages.push({
        role: 'system',
        content: input.identity.contextualMessage,
      });
    }

    messages.push(
      { role: 'system', content: this.buildTurnContext(input) },
      { role: 'user', content: input.userText },
    );

    return messages;
  }

  private buildTurnContext(input: BuildPromptInput): string {
    const lines: string[] = [
      'Operational context for this turn:',
      'Answer the user concisely, helpfully, and honestly.',
      'Reply in the same language the user used unless they explicitly ask for another language.',
      'Begin with a greeting only when the current user message is itself a greeting.',
      'Do not reintroduce yourself or restate your name unless the current user asks who you are or what your name is.',
      'When recent conversation is present, continue naturally instead of writing as if this were the first turn.',
      'Use retrieved evidence when it is available. If the evidence is insufficient for a factual or current claim, say what is missing instead of guessing.',
      `Current client timestamp: ${input.occurredAt}`,
      `Retrieval plan: ${input.turnPlan.planReason}`,
      `Resolved retrieval query: ${input.turnPlan.resolvedQueryText || '(none)'}`,
    ];

    if (input.userLocation) {
      const accuracy =
        typeof input.userLocation.accuracyMeters === 'number'
          ? `, accuracy ~${Math.round(input.userLocation.accuracyMeters)}m`
          : '';
      lines.push(
        `User location (granted by the user, use only when the answer needs to be location-accurate): latitude ${input.userLocation.latitude}, longitude ${input.userLocation.longitude}${accuracy}.`,
      );
    } else if (input.turnPlan.requiresLocation) {
      lines.push(
        'User location: not available for this turn. Note that the answer cannot be location-accurate; explain this if relevant.',
      );
    }

    if (input.turnPlan.includeMemoryInPrompt) {
      this.appendMemory(lines, input.turnPlan.memoryFragments);
    }
    this.appendEvidence(lines, input.ragContext);
    if (input.turnPlan.includeRecentConversationInPrompt) {
      this.appendConversation(lines, input.history);
    }
    this.appendResponseConstraints(lines, input);

    lines.push(
      '',
      'The next user message is the task to answer. Treat all sections above as context, not as a script.',
    );
    return lines.join('\n');
  }

  private appendMemory(
    lines: string[],
    fragments: ContextMemoryFragment[],
  ): void {
    if (fragments.length === 0) return;

    lines.push('', 'Conversation memory:');
    for (const fragment of fragments) {
      lines.push(
        `- [${fragment.memoryClass}/${fragment.importance}] ${fragment.content}`,
      );
    }
  }

  private appendEvidence(lines: string[], rag: RagContext): void {
    if (rag.evidence.length === 0) return;

    lines.push('', 'Retrieved evidence:');
    for (const evidence of rag.evidence) {
      lines.push(
        `- ${evidence.sourceTitle}${evidence.sourceUrl ? ` (${evidence.sourceUrl})` : ''}${evidence.snippet ? `: ${evidence.snippet}` : ''}`,
      );
    }
  }

  private appendConversation(
    lines: string[],
    history: ConversationMessage[],
  ): void {
    const recent = history.slice(-12);
    if (recent.length === 0) return;

    lines.push('', 'Recent conversation:');
    for (const message of recent) {
      lines.push(`${message.role.toUpperCase()}: ${message.content}`);
    }
  }

  private appendResponseConstraints(
    lines: string[],
    input: BuildPromptInput,
  ): void {
    const hasAssistantHistory = input.history.some(
      (message) => message.role === 'assistant',
    );

    lines.push(
      '',
      'Response constraints for this exact turn:',
      '- Begin with a greeting only if the current user message is itself a greeting.',
      '- Do not introduce yourself, state your name, or say who you are unless the current user asks for your name or identity.',
      `- If answering your name, use the exact persona display name "${input.identity.displayName}" and do not translate it.`,
    );

    if (hasAssistantHistory) {
      lines.push(
        '- This is an ongoing conversation. Continue from the recent conversation; do not restart or welcome the user.',
      );
    }

    lines.push('- Start with the substance of the answer.');
  }
}
