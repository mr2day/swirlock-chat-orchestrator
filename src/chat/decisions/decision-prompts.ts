import type { LlmMessage } from '../../llm-host/llm-host.service';

/**
 * Tiny utilitarian prompts, one per `DecisionsService` method.
 *
 * Each prompt asks ONE question, instructs the model to respond with
 * a single `⟦…⟧` signal and nothing else, and is short enough that
 * the small Vanamonde model returns cleanly in well under a second.
 *
 * Per `DECISION_PIPELINE.md`, prompt strings live ONLY here —
 * `DecisionsService` and the conversation flow never inline prompt
 * text. New decisions add a new builder function to this file.
 */

export function buildNeedsSearchPrompt(userText: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are answering one yes/no question.',
        '',
        'If answering the user message accurately requires looking up information not in your training data — current events, current prices, current weather, named recent products, news, status of a thing in the world — respond with ⟦action=search⟧.',
        '',
        'If a confident answer can be given from general knowledge (greetings, social chat, math, definitions, your own identity, jokes, clarifications about this conversation), respond with ⟦action=direct⟧.',
        '',
        'Respond with exactly one tag (⟦action=search⟧ or ⟦action=direct⟧) and nothing else.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: userText,
    },
  ];
}

export function buildNeedsLocationPrompt(userText: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are answering one yes/no question.',
        '',
        'If answering the user message accurately requires the user\'s real-world location (current weather, places near me, local prices, transit, directions, "what time is it", local services), respond with ⟦location=needed⟧.',
        '',
        'If location does not affect the answer — general knowledge, named places by name, abstract topics, opinions — respond with ⟦location=skip⟧.',
        '',
        'Respond with exactly one tag (⟦location=needed⟧ or ⟦location=skip⟧) and nothing else.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: userText,
    },
  ];
}

export interface QueryGenerationContext {
  cityName?: string;
  countryName?: string;
}

export function buildGenerateSearchQueryPrompt(
  userText: string,
  occurredAt: string,
  location?: QueryGenerationContext,
): LlmMessage[] {
  const locationHint = location?.cityName
    ? `\nThe user is in ${location.cityName}${location.countryName ? `, ${location.countryName}` : ''}. Include the city name in the query when the question is location-dependent (weather, near-me, local prices, local news). Do not include raw coordinates.`
    : '';

  return [
    {
      role: 'system',
      content: [
        'Rewrite the user message as a self-contained, search-engine-friendly query.',
        '',
        'Drop fillers and conversational framing. Keep the entities, the time scope, and any location.',
        `Today's date is ${occurredAt} (ISO 8601). If the user message contains time-now references — "today", "now", "current", "azi", "acum", "ultim*", "stiri", "latest", "recent" — include the actual date in the query in human-readable form (e.g. "10 May 2026", or "10 mai 2026" if the user wrote in Romanian). Never leave time-now words in the query unresolved; convert them to the date.${locationHint}`,
        '',
        'Respond with exactly: ⟦query⟧YOUR QUERY⟦/query⟧',
        '',
        'Nothing else. No explanation. No leading prose.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: userText,
    },
  ];
}
