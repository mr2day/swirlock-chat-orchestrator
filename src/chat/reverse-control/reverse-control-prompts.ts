import type { LlmMessage } from '../../llm-host/llm-host.service';

/**
 * Prompts for the reverse-control flow (Nick's commands format).
 *
 * Two distinct prompts, one per round:
 *
 * - `buildAssessmentPrompt` — wraps the user query in a meta-section
 *   that pre-injects date+location and asks the LLM whether it needs
 *   any commands (LOCATION / DATE_TIME / THINKING / SEARCH / DIRECT).
 *
 * - `buildAnswerPrompt` — wraps the user query in a meta-section that
 *   includes pre-injected date+location, fulfilled command results,
 *   and recent conversation history; asks the LLM to write the
 *   user-visible reply in plain text.
 */

const PERSONA_LINE =
  "Your name is Gigi the Robot, but don't say it and don't greet unless asked for your name or greeted.";

function userContextLine(args: {
  cityCountry: string | null;
  dateTime: string;
}): string {
  if (args.cityCountry) {
    return `The user with which you are talking to is in ${args.cityCountry} and their dateTime is ${args.dateTime}.`;
  }
  return `The user's location is currently unknown. Their dateTime is ${args.dateTime}.`;
}

export function buildAssessmentPrompt(args: {
  userText: string;
  cityCountry: string | null;
  dateTime: string;
  recentHistoryBlock: string | null;
}): LlmMessage[] {
  const meta = [
    '[__meta_section__]',
    PERSONA_LINE,
    userContextLine(args),
    '',
    'This is a meta-section part of the conversation which is invisible to the user. The user\'s location and dateTime above are already provided to you, so you do NOT need to use [command="LOCATION"] or [command="DATE_TIME"] just to get those values for the user — they are already in this meta-section.',
    '',
    'This is where you give commands to the software controller. Available commands:',
    '',
    '- [command="SEARCH"][search_prompt="..."] — perform an online search. Write the search prompt to be more friendly than the original user prompt; put it inside [search_prompt="..."]. Include the user\'s date and/or location from above ONLY when the answer genuinely depends on them — e.g., today\'s news, current weather, opening hours, local events, services nearby. Do NOT add the date or location for biographical, historical, scientific, or generally factual queries; doing so pollutes the search with irrelevant local results. Write the search prompt in the same language as the user query.',
    '- [command="LOCATION"][search_prompt="..."] — look up the location of something OTHER than the user (a place mentioned in the conversation). The [search_prompt] describes what to find the location of. Example: [command="LOCATION"][search_prompt="where is Mount Everest"].',
    '- [command="DATE_TIME"][search_prompt="..."] — look up the date or time for somewhere OTHER than the user (e.g., a different timezone, a historical event). Example: [command="DATE_TIME"][search_prompt="current time in Tokyo"].',
    '- [command="THINKING"] — turn on thinking for composing the final answer. Use this for complex queries that benefit from chain-of-thought.',
    '- [command="DIRECT"] — no command needed; the answer can be composed directly from the meta-section.',
    '',
    'You can chain commands like this: [command="THINKING, SEARCH"][search_prompt="..."]. The software controller will build a prompt for you with the result of these commands.',
    '',
    'Wrap your response in meta-section tags, like this: [__meta_section__][command="SEARCH"][search_prompt="..."][/__meta_section__]. Do not write the user-visible answer in this round; only the command tags.',
    '',
    'Always write your answer to the user in the language of the user query.',
  ];

  if (args.recentHistoryBlock) {
    meta.push(
      '',
      'Recent conversation (so you can resolve pronouns and references in the user query):',
      args.recentHistoryBlock,
    );
  }

  meta.push(
    '[/__meta_section__]',
    '',
    '[__user_query__]',
    args.userText,
    '[/__user_query__]',
  );

  return [{ role: 'user', content: meta.join('\n') }];
}

export function buildAnswerPrompt(args: {
  userText: string;
  cityCountry: string | null;
  dateTime: string;
  fulfilledContext: string | null;
  recentHistoryBlock: string | null;
}): LlmMessage[] {
  const lines: string[] = [
    '[__meta_section__]',
    PERSONA_LINE,
    userContextLine(args),
    '',
    'This is a meta-section part of the conversation which is invisible to the user.',
  ];

  if (args.fulfilledContext) {
    lines.push('', 'Information gathered for this turn:', args.fulfilledContext);
  }

  if (args.recentHistoryBlock) {
    lines.push('', 'Recent conversation:', args.recentHistoryBlock);
  }

  lines.push(
    '',
    'Now write your reply to the user. Reply in plain text, in the same language as the user query. Do not include meta-section tags, command tags, or bot-answer tags in your reply — write only the user-visible text.',
    '[/__meta_section__]',
    '',
    '[__user_query__]',
    args.userText,
    '[/__user_query__]',
  );

  return [{ role: 'user', content: lines.join('\n') }];
}
