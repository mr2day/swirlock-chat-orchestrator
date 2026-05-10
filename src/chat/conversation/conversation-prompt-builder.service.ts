import { Injectable } from '@nestjs/common';
import type { LlmMessage } from '../../llm-host/llm-host.service';
import type { RagContext } from '../../rag/rag.service';
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
  ragContexts: RagContext[];
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
    const messages: LlmMessage[] = [];

    // Persona system prompts disabled — debug log readability.
    // To re-enable, uncomment:
    // messages.push({ role: 'system', content: input.identity.coreMessage });
    // if (input.identity.contextualMessage) {
    //   messages.push({ role: 'system', content: input.identity.contextualMessage });
    // }

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
      "Language: reply in the exact same language as the user's most recent message, regardless of the language of any system instructions above. If the user wrote in Romanian, reply in Romanian. If in English, reply in English. Do not translate the user's words into another language to answer them.",
      'Never tell the user you cannot search, cannot access the internet, or do not have access to current/future data — the orchestrator already searched on your behalf when relevant; if the search returned nothing, say what is missing or ask a clarifying question (e.g. ask the user for their city for weather queries) instead of refusing.',
      `Current client timestamp: ${input.occurredAt}`,
    ];

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
