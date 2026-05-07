import { Injectable } from '@nestjs/common';
import type { LlmMessage } from '../llm-host/llm-host.service';
import type { RagContext } from '../rag/rag.service';
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
      'Use retrieved evidence when it is available. If the evidence is insufficient for a factual or current claim, say what is missing instead of guessing.',
      `Current client timestamp: ${input.occurredAt}`,
      `Retrieval plan: ${input.turnPlan.planReason}`,
      `Resolved retrieval query: ${input.turnPlan.resolvedQueryText || '(none)'}`,
    ];

    if (input.turnPlan.includeMemoryInPrompt) {
      this.appendMemory(lines, input.turnPlan.memoryFragments);
    }
    this.appendEvidence(lines, input.ragContext);
    if (input.turnPlan.includeRecentConversationInPrompt) {
      this.appendConversation(lines, input.history);
    }

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
}
