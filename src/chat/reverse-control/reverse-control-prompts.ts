import type { LlmMessage } from '../../llm-host/llm-host.service';
import { describeCommandTable } from './command-table';

/**
 * Prompts for the reverse-control flow.
 *
 * Two distinct prompts, one per round:
 *
 * - `buildAssessmentPrompt` — asks the LLM what it needs, given the
 *   user message and any context already fulfilled in earlier rounds
 *   of the same turn. The LLM responds with `[need="..."]` markers
 *   and/or `[done]`.
 *
 * - `buildAnswerPrompt` — asks the LLM to compose the user-visible
 *   answer, given the user message and all fulfilled context. This
 *   is the only round whose output streams to the user.
 */

export function buildAssessmentPrompt(args: {
  userText: string;
  fulfilledContext: string | null;
}): LlmMessage[] {
  const lines = [
    'You decide what information you need before answering the user.',
    '',
    describeCommandTable(),
    '',
    'Rules:',
    '- Output ONLY needs and/or [done]. No prose, no explanation, no answer text.',
    '- Multiple needs in one response are fine. Example: [need="date", need="location"]',
    '- A need can have one argument. Example: [need="search", query="vremea Bucuresti 10 mai 2026"]',
    "- If you already have everything you need to answer the user (or the user's message does not require anything from this list), output [done] alone.",
    '- Do NOT request a need that is already listed under "Already fulfilled" below.',
  ];

  if (args.fulfilledContext) {
    lines.push('', 'Already fulfilled in this turn:', args.fulfilledContext);
  }

  return [
    { role: 'system', content: lines.join('\n') },
    { role: 'user', content: args.userText },
  ];
}

export function buildAnswerPrompt(args: {
  userText: string;
  fulfilledContext: string | null;
  recentHistoryBlock: string | null;
}): LlmMessage[] {
  const lines = [
    'Compose the answer to the user.',
    '',
    'Reply in the exact same language as the user. Plain text, no JSON, no markers, no internal protocol leaking through.',
    'Use the fulfilled context below when relevant. If something the user asked for is missing, say what is missing rather than inventing facts.',
  ];

  if (args.fulfilledContext) {
    lines.push('', 'Fulfilled context for this turn:', args.fulfilledContext);
  }

  if (args.recentHistoryBlock) {
    lines.push('', 'Recent conversation:', args.recentHistoryBlock);
  }

  return [
    { role: 'system', content: lines.join('\n') },
    { role: 'user', content: args.userText },
  ];
}
