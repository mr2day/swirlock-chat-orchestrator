import { Injectable } from '@nestjs/common';
import type { RagContext } from '../rag/rag.service';
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
}

@Injectable()
export class PromptBuilderService {
  build(input: BuildPromptInput): string {
    const lines: string[] = [
      'You are the Swirlock assistant. Answer the user concisely, helpfully, and honestly.',
      'Use retrieved evidence when it is available. If the evidence is insufficient for a factual or current claim, say what is missing instead of guessing.',
      `Current client timestamp: ${input.occurredAt}`,
      `Retrieval plan: ${input.turnPlan.planReason}`,
      `Resolved retrieval query: ${input.turnPlan.resolvedQueryText || '(none)'}`,
    ];

    this.appendMemory(lines, input.turnPlan.memoryFragments);
    this.appendEvidence(lines, input.ragContext);
    this.appendConversation(lines, input.history);

    lines.push(
      '',
      'Current user message:',
      input.userText,
      '',
      'Assistant response:',
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
