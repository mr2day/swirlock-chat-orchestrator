import { Injectable } from '@nestjs/common';
import type { LlmMessage } from '../../llm-host/llm-host.service';
import type { RagContext } from '../../rag/rag.service';
import type { AgentObservation } from '../commands/agent-command.types';
import type {
  ConversationConsolidation,
  ConversationMessage,
} from './conversation-history.service';
import type { PersonaIdentityCapsule } from '../persona/persona-identity.service';

export interface BuildConversationPromptInput {
  identity: PersonaIdentityCapsule;
  history: ConversationMessage[];
  consolidation: ConversationConsolidation;
  userText: string;
  occurredAt: string;
  observations: AgentObservation[];
  ragContexts: RagContext[];
  activePlanSummary: string | null;
  activitySummary: string | null;
}

const RECENT_HISTORY_LIMIT = 12;

/**
 * Builds the streaming final-answer prompt — the user-visible model
 * call, in text mode, with the full response budget.
 *
 * Treats fragmenter-side consolidation as optional. When a session
 * summary is present, it is injected as a system block before the
 * recent history so the model has the older context without rereading
 * the full transcript. When absent, the prompt is still coherent —
 * just shorter, falling back on raw history alone.
 */
@Injectable()
export class ConversationPromptBuilderService {
  buildMessages(input: BuildConversationPromptInput): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: 'system', content: input.identity.coreMessage },
    ];

    if (input.identity.contextualMessage) {
      messages.push({
        role: 'system',
        content: input.identity.contextualMessage,
      });
    }

    if (input.consolidation.sessionSummary) {
      messages.push({
        role: 'system',
        content: this.buildConsolidationBlock(input.consolidation),
      });
    }

    messages.push({
      role: 'system',
      content: this.buildTurnContext(input),
    });

    for (const historyMessage of input.history.slice(-RECENT_HISTORY_LIMIT)) {
      if (historyMessage.role === 'system') continue;
      messages.push({
        role: historyMessage.role,
        content: historyMessage.content,
      });
    }

    messages.push({ role: 'user', content: input.userText });
    return messages;
  }

  private buildConsolidationBlock(
    consolidation: ConversationConsolidation,
  ): string {
    const lines = [
      'Rolling summary of earlier conversation (background context, may be stale):',
    ];
    if (consolidation.generatedAt) {
      lines.push(`(generated at ${consolidation.generatedAt})`);
    }
    lines.push('');
    lines.push(consolidation.sessionSummary ?? '');
    lines.push(
      '',
      'Use this summary as background; the most recent messages below override it where they conflict.',
    );
    return lines.join('\n');
  }

  private buildTurnContext(input: BuildConversationPromptInput): string {
    const lines = [
      'Turn context:',
      'Continue the conversation naturally using the messages below.',
      'Use the retrieved evidence when relevant. If evidence is missing or insufficient, say what is missing instead of guessing.',
      'Respond in plain text (no JSON, no XML, no internal protocol).',
      'Answer in the same language as the user unless the user asked otherwise.',
      `Current client timestamp: ${input.occurredAt}`,
    ];

    if (input.activitySummary) {
      lines.push(
        '',
        'Recent agent activity for this session:',
        input.activitySummary,
      );
    }

    if (input.activePlanSummary) {
      lines.push('', input.activePlanSummary);
    }

    if (input.observations.length > 0) {
      lines.push('', 'Observations from commands run in this turn:');
      input.observations.forEach((observation, index) => {
        lines.push(
          `${index + 1}. [${observation.kind}] ${observation.summary}`,
        );
      });
    }

    const evidence = input.ragContexts.flatMap((context) => context.evidence);
    if (evidence.length > 0) {
      lines.push('', 'Retrieved evidence:');
      for (const item of evidence.slice(0, 12)) {
        lines.push(
          `- ${item.sourceTitle}${item.sourceUrl ? ` (${item.sourceUrl})` : ''}${item.snippet ? `: ${item.snippet}` : ''}`,
        );
      }
    }

    return lines.join('\n');
  }
}
