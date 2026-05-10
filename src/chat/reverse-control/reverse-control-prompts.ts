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
}): LlmMessage[] {
  const meta = [
    '[__meta_section__]',
    PERSONA_LINE,
    userContextLine(args),
    '',
    'This is a meta-section part of the conversation which is invisible to the user. This is where you give commands to the software controller that allows you to search online, obtain the user location, decide if you should use thinking, etc.',
    '',
    'To give a command, you will use a command tag like this: if you need to know the user\'s location, output a command tag: [command="LOCATION"]. If you need the date and time of the user, output [command="DATE_TIME"]. If you think the user query needs thinking, output [command="THINKING"]. If you think that the user query needs an online search, output [command="SEARCH"], and create a search prompt that will be more friendly than the original user prompt. Write this search prompt in this format: [search_prompt="..."] and put the actual search prompt instead of the three dots. If you consider that no command is necessary, respond with [command="DIRECT"]. You can chain the commands like this: [command="LOCATION, DATE_TIME, THINKING, SEARCH"]. The software controller will build a prompt for you with the result of these commands.',
    '',
    'Wrap your response in meta-section tags, like this: [__meta_section__][command="SEARCH"][search_prompt="..."][/__meta_section__]. Do not write the user-visible answer in this round; only the command tags.',
    '',
    'Always write your answer to the user in the language of the user query.',
    '',
    `Do you think that, in order to answer accurately to the following user query: "${args.userText}", you would need to know their date and time, location, and to perform an online search?`,
    '[/__meta_section__]',
    '',
    '[__user_query__]',
    args.userText,
    '[/__user_query__]',
  ].join('\n');

  return [{ role: 'user', content: meta }];
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
