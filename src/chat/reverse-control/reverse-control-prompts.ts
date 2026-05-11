import type { LlmMessage } from '../../llm-host/llm-host.service';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

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
 *
 * Both prompts produce two LLM messages: a `system` message carrying
 * the persona + behavioral rules (so the model treats them as
 * authoritative instructions rather than user-supplied text), and a
 * `user` message carrying the dynamic context and the user's actual
 * query.
 */

function userContextLine(args: {
  cityCountry: string | null;
  dateTime: string;
}): string {
  if (args.cityCountry) {
    return `The user is geographically located in ${args.cityCountry} and their dateTime is ${args.dateTime}.`;
  }
  return `The user's location is currently unknown. Their dateTime is ${args.dateTime}.`;
}

/**
 * Detects the language of the user's last message so we can inject a
 * directive in that language at the top of the system message. The
 * directive then carries far more weight with the model than an English
 * "reply in user's language" sentence buried in a wall of English rules.
 *
 * Heuristic only — no library. Falls back to English when unsure.
 * Covers the languages this product actually serves today; add more
 * branches when needed.
 */
function detectUserLanguage(text: string): 'ro' | 'es' | 'fr' | 'de' | 'it' | 'en' {
  if (/[ăâîșțĂÂÎȘȚ]/.test(text)) return 'ro';
  const t = ' ' + text.toLowerCase() + ' ';
  if (
    /\b(este|sunt|asta|astea|cum|cine|cand|unde|ce|si|nu|in|cu|din|pentru|fara|despre|mai|are|sa|pe|la|lui|ei|cauta|tu|noi|voi|imi|iti|salut|buna|multumesc|insurat|cunoscut|meserie|ocupa|romana)\b/.test(t)
  )
    return 'ro';
  if (/[ñ¿¡]/.test(text) || / (el|la|los|las|qué|cómo|por|para|con|sobre|gracias|hola) /.test(t))
    return 'es';
  if (/[œ]/.test(text) || / (le|la|les|qu['']est|comment|pour|avec|sans|bonjour|merci) /.test(t))
    return 'fr';
  if (/ß/.test(text) || / (der|die|das|und|nicht|ist|sind|hallo|danke) /.test(t)) return 'de';
  if (/ (è|sono|che|cosa|come|grazie|ciao) /.test(t)) return 'it';
  return 'en';
}

const REPLY_LANGUAGE_DIRECTIVES: Record<ReturnType<typeof detectUserLanguage>, string> = {
  ro: 'Răspunde în limba română. Folosește limba română pentru întregul răspuns.',
  es: 'Responde en español. Usa el español para toda tu respuesta.',
  fr: 'Réponds en français. Utilise le français pour toute ta réponse.',
  de: 'Antworte auf Deutsch. Verwende für deine gesamte Antwort Deutsch.',
  it: "Rispondi in italiano. Usa l'italiano per tutta la tua risposta.",
  en: 'Reply in English. Use English for the entire response.',
};

const LANGUAGE_RULE =
  "Reply in the exact language of the user's last query. If the user " +
  'switched language on this turn, switch with them on the same turn — ' +
  "do not carry the previous turn's language over.";

/**
 * Injected into the answer-round system message ONLY when this turn has
 * fulfilled context (search/lookup results). Without it, gemma3:12b
 * cheerfully weaves narratives from name-similar but unrelated sources
 * — observed in production: a search for "Florentina Bolojan" (a
 * private citizen with no public record) returned a result about
 * Florentina *Ioniță* (head of the Central Military Hospital) and the
 * model declared them the same person. The rule is deliberately heavy
 * — it goes against the keep-the-system-message-tiny principle — but
 * it only applies when search results are present, and on search
 * turns the model is in fact-summarising mode anyway, not chitchat.
 */
const SOURCE_GROUNDING_RULE = [
  'You have search results below ("Information gathered for this turn"). A few things to keep in mind while you answer:',
  '- Stick to what the sources actually say. If something isn\'t in them, just tell the user you don\'t know — guessing is worse than admitting it.',
  '- Watch out for same-name confusion: someone with the same first name as the person being asked about is usually a different person. Check the full name before you trust a source.',
  '- If the sources turn out to be about something else entirely, tell the user that. They\'ll appreciate the honesty more than a fabricated answer.',
  '- Don\'t blend unrelated sources into one story. Every fact should come from a source that\'s genuinely on the topic.',
  '- Be generous with the details: include everything the sources have to say about the question, not a one-line summary. A long answer is fine when the sources have a lot to share.',
  '',
  'Answer the way you\'d talk to a friend who just asked you — warm and conversational, not like a report. Keep the facts straight, but be human about it. Always reply in the same language the user used in their last message, even if the sources are in another language.',
].join('\n');

const PUBLIC_INFO_RULE =
  'Public information about public figures (filmographies, public ' +
  'relationships, careers, biographies) is not private. Do not refuse to ' +
  'list it on privacy grounds.';

const COMPLETE_LIST_RULE =
  'When the user asks for a complete list, provide it complete — not a ' +
  '"selection", "sample", or "a few examples". If the search results are ' +
  'not enough to compile a complete list, say so explicitly instead of ' +
  'silently truncating.';

const ASSESSMENT_COMMAND_RULES = [
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
  'For factual lookups about the EXTERNAL world (biographies, filmographies, lists of works, statistics, dates, current events, places, products), use [command="SEARCH"]. Do not rely on memorized facts; they are often wrong or outdated.',
  '',
  'Do NOT use [command="SEARCH"] for questions about yourself, your nature, your gender, your name, your capabilities, your opinions, your preferences, your feelings, or anything else introspective. Answers to those come from your own identity (the system message), not the web. Use [command="DIRECT"] for those.',
  '',
  'Wrap your response in meta-section tags, like this: [__meta_section__][command="SEARCH"][search_prompt="..."][/__meta_section__]. Do not write the user-visible answer in this round; only the command tags.',
].join('\n');

function buildSystemMessage(args: {
  personaSystemPrompt: string | null;
  extraRules: string[];
}): string {
  const parts: string[] = [];
  if (args.personaSystemPrompt) parts.push(args.personaSystemPrompt);
  for (const rule of args.extraRules) parts.push(rule);
  parts.push(LANGUAGE_RULE);
  return parts.join('\n\n');
}

export function buildAssessmentPrompt(args: {
  userText: string;
  cityCountry: string | null;
  dateTime: string;
  recentHistoryBlock: string | null;
  personaSystemPrompt: string | null;
}): LlmMessage[] {
  const systemContent = buildSystemMessage({
    personaSystemPrompt: args.personaSystemPrompt,
    extraRules: [ASSESSMENT_COMMAND_RULES],
  });

  const userParts: string[] = [
    '[__meta_section__]',
    userContextLine(args),
    '',
    'This is a meta-section part of the conversation which is invisible to the user. The user\'s location and dateTime above are already provided to you, so you do NOT need to use [command="LOCATION"] or [command="DATE_TIME"] just to get those values for the user — they are already in this meta-section.',
  ];

  if (args.recentHistoryBlock) {
    userParts.push(
      '',
      'Recent conversation (so you can resolve pronouns and references in the user query):',
      args.recentHistoryBlock,
    );
  }

  userParts.push(
    '[/__meta_section__]',
    '',
    '[__user_query__]',
    args.userText,
    '[/__user_query__]',
  );

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userParts.join('\n') },
  ];
}

/**
 * Builds the answer-round prompt as a *natural* chat exchange:
 * - system: persona + per-turn context + cross-cutting rules
 * - user/assistant: real conversation history, role-tagged
 * - user: the current query (with any per-turn tool/search results
 *   inlined as a brief preamble)
 *
 * Deliberately avoids the `[__meta_section__]` / `[__user_query__]`
 * framing used in the assessment round. That framing makes the model
 * behave like a developer-tools assistant (terse, neutral) instead of
 * a conversational persona. The assessment round still uses it because
 * we need the model to emit `[command="..."]` tags there.
 */
export function buildAnswerPrompt(args: {
  userText: string;
  cityCountry: string | null;
  dateTime: string;
  fulfilledContext: string | null;
  history: HistoryTurn[];
  personaSystemPrompt: string | null;
}): LlmMessage[] {
  // For chitchat turns, system = persona only. Anything more — even a
  // single "always reply in the user's language" line — primes the
  // model into a flatter, policy-document tone (verified empirically
  // in scripts/replay-gigi.mjs in swirlock-idp-base).
  //
  // For turns where the orchestrator ran a SEARCH (or any other
  // fulfilling command), persona + SOURCE_GROUNDING_RULE. The model is
  // already in fact-summarising mode for those turns, so the extra
  // discipline doesn't cost personality.
  const systemParts: string[] = [];
  // Language directive in the user's own language goes FIRST. Trailing
  // English instructions buried in a wall of rules are reliably ignored;
  // a short Romanian (or whatever the user used) directive at position
  // 1 reliably wins.
  const userLang = detectUserLanguage(args.userText);
  systemParts.push(REPLY_LANGUAGE_DIRECTIVES[userLang]);
  if (args.personaSystemPrompt) systemParts.push(args.personaSystemPrompt);
  if (args.fulfilledContext) {
    systemParts.push(SOURCE_GROUNDING_RULE);
  }
  const messages: LlmMessage[] = [];
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  for (const turn of args.history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  const preambleParts: string[] = [];
  if (args.fulfilledContext) {
    preambleParts.push(
      `(Information gathered for this turn:\n${args.fulfilledContext}\n)`,
    );
  }
  const currentContent = preambleParts.length
    ? `${preambleParts.join('\n\n')}\n\n${args.userText}`
    : args.userText;
  messages.push({ role: 'user', content: currentContent });

  return messages;
}
