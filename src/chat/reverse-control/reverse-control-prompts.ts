import { franc } from 'franc-min';
import type { LlmMessage } from '../../llm-host/llm-host.service';
import { estimateTokens } from '../utils/token-estimator';

/**
 * ISO 639-3 → English language name. Used by `detectLanguageHint`
 * to phrase the per-turn note for the answer-round model. Covers
 * the European set the app's user base actually writes in. Add to
 * this list freely; missing codes simply suppress the hint (the
 * LLM falls back to LANGUAGE_RULE alone, which is still correct).
 */
const ISO_639_3_TO_LANGUAGE_NAME: Record<string, string> = {
  ron: 'Romanian',
  spa: 'Spanish',
  fra: 'French',
  ita: 'Italian',
  deu: 'German',
  por: 'Portuguese',
  pol: 'Polish',
  ell: 'Greek',
  nld: 'Dutch',
  rus: 'Russian',
  ukr: 'Ukrainian',
  tur: 'Turkish',
  ces: 'Czech',
  slk: 'Slovak',
  hun: 'Hungarian',
  bul: 'Bulgarian',
  hrv: 'Croatian',
  srp: 'Serbian',
  slv: 'Slovenian',
  swe: 'Swedish',
  nor: 'Norwegian',
  dan: 'Danish',
  fin: 'Finnish',
  est: 'Estonian',
  lit: 'Lithuanian',
  lav: 'Latvian',
  cat: 'Catalan',
  eus: 'Basque',
  glg: 'Galician',
  cym: 'Welsh',
  gle: 'Irish',
  isl: 'Icelandic',
  mlt: 'Maltese',
};

/**
 * Per-turn language-hint detector. Runs franc-min on the user's
 * most recent text. Returns a short system-message string only when
 * detection is CONFIDENT and the language is NOT English. When
 * detection is uncertain ('und'), we deliberately return null and
 * let the model default to English — biasing toward English on
 * uncertain short input avoids the failure mode where a 2-word
 * Romanian message ("Te iubesc") is treated as a phrase to discuss
 * in the conversation's current language instead of a language
 * switch.
 *
 * Injected as a fresh system message right before the user's text
 * in the answer-round prompt — the latest authoritative cue the
 * model sees.
 */
export function detectLanguageHint(userText: string): string | null {
  if (!userText) return null;
  const trimmed = userText.trim();
  if (trimmed.length < 3) return null;
  let iso: string;
  try {
    iso = franc(trimmed, { minLength: 3 });
  } catch {
    return null;
  }
  if (iso === 'und' || iso === 'eng') return null;
  const name = ISO_639_3_TO_LANGUAGE_NAME[iso];
  if (!name) return null;
  return `LANGUAGE NOTE FOR THIS TURN: The user's most recent message is in ${name}. Your ENTIRE reply (every sentence, every aside) must be in ${name}. This binding overrides any pull toward the conversation's prior language.`;
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Message seq from the orchestrator's messages table. Used by
   *  the budget walk to ask the fragmenter for a summary that
   *  covers exactly the dropped range. */
  seq: number;
}

export interface SessionSummaryHit {
  summary: string;
  /** Seq cutoff this summary covers (1..throughSeq inclusive). */
  throughSeq: number;
}

/**
 * Per-message token overhead the chat template adds around role
 * markers and separators. Coarse but fine for budgeting.
 */
const PER_MESSAGE_TOKEN_OVERHEAD = 4;

function tokensForText(text: string): number {
  return estimateTokens(text) + PER_MESSAGE_TOKEN_OVERHEAD;
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
  return `The user's dateTime is ${args.dateTime}.`;
}

/**
 * Compact context block injected into the answer-round system prompt
 * so the persona model can naturally reference where/when the user is
 * without having to be asked. When location isn't available from the
 * frontend, the location bullet is omitted entirely — no apologetic
 * "I don't know" line.
 */
function buildAnswerContextBlock(
  cityCountry: string | null,
  dateTime: string,
): string {
  const bullets: string[] = [];
  if (cityCountry) {
    bullets.push(`- The user is located in ${cityCountry}.`);
  }
  bullets.push(`- The current date and time for the user is ${dateTime}.`);
  return `Context you can rely on without being told:\n${bullets.join('\n')}\nUse these whenever they're relevant, but don't volunteer them unprompted.`;
}

/**
 * THE highest-priority rule. Stated at the start of the system
 * prompt and repeated verbatim at the end. Nothing else overrides
 * it — not the persona, not prior turns, not any other instruction.
 * No specific language is named anywhere (naming a language primes
 * the model toward it regardless of what the user wrote).
 */
const LANGUAGE_RULE =
  "ABSOLUTE RULE — HIGHEST PRIORITY, OVERRIDES EVERYTHING ELSE IN THIS PROMPT: Reply in the exact same language as the user's last message. If the user switches language on a turn, switch with them on that same turn. No persona voice, no prior-turn habit, no other rule below can change this.";

const LANGUAGE_RULE_REMINDER =
  "REMINDER OF THE ABSOLUTE RULE: Reply in the exact same language as the user's last message. This overrides anything stated above.";

/**
 * Injected only when a session summary is included in this turn's
 * prompt. Tells the model how its own context is laid out so it can
 * answer "what was my first message" / "what did we talk about an
 * hour ago" accurately instead of treating the oldest raw message
 * it sees as "the first" — the literal first is in the summary.
 *
 * Without this, small models tend to treat the raw window as the
 * whole conversation and quote its oldest entry when asked "first".
 */
const STRUCTURAL_AWARENESS_RULE = [
  "PROMPT STRUCTURE: This turn's context is laid out for you as:",
  '  1. The system messages above (persona, rules, current date/location).',
  '  2. A session summary covering messages 1..N — your compressed memory of earlier turns that did not fit verbatim.',
  '  3. The raw conversation from message N+1 through this turn, role-tagged.',
  '  4. The current user message.',
  '',
  'If the user asks about earlier turns:',
  '  - If the message they reference is in the raw block, quote it verbatim.',
  '  - If it predates the raw block, it is in the SUMMARY. Use the summary to describe it, and be honest that you are paraphrasing from a summary, not quoting.',
  '  - Never claim a message from the raw block is the "first" of the session when a summary is present — the literal first is in the summary, message 1.',
  '  - If the user asks you to describe the structure of your own context, describe it (these four blocks above). Do not deny that you have access to summaries and raw history.',
].join('\n');

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
  'You will see "Information gathered for this turn" with search results in the user message. Treat them strictly:',
  '- State ONLY facts explicitly supported by the sources. If a fact is not in any source, say you do not know — do not guess, do not extrapolate.',
  '- Names: people with the same first name are NOT the same person. If a source talks about someone whose full name does not match the entity the user is asking about, the source is about a different person — ignore it. Never claim that someone "is also known as" a different surname unless a source explicitly states the alias.',
  '- If none of the sources actually address the user\'s question, say so honestly. Tell the user the search results were not about the topic, instead of fabricating an answer from unrelated material.',
  '- Do not stitch unrelated sources into a single narrative. Each fact must trace back to a source that is genuinely on-topic.',
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

/**
 * Pro-elaboration rule (opposite intent of SOURCE_GROUNDING_RULE).
 * Tells the model to use the surrounding context the sources provide,
 * not just the minimum needed to answer the literal question. Applied
 * only on turns with fulfilled context.
 */
const ELABORATION_RULE = [
  'When the search results contain related context, background, or supporting facts beyond the literal question, include them.',
  'A yes/no question with a rich source set deserves a full answer — share what is relevant in the sources, not just the minimum needed to answer literally.',
  'Use the names, dates, places, and connected details the sources mention, even if they go beyond the strict scope of the question — as long as those details are actually in the sources.',
].join('\n');

/**
 * Consensus rule, injected on every search-turn alongside
 * ELABORATION_RULE. Treats the source set as a group rather than
 * a buffet of independent claims to pick from.
 *
 * Motivating incident (2026-05-15): a SEARCH for the Dubois vs
 * Itauma matchup returned 15 sources. 14 reported the fight had
 * not happened yet (Dubois recently won the WBO title against
 * Wardley, Itauma is the mandatory challenger, the matchup is
 * scheduled for summer 2026). One outlier from a low-quality
 * content farm claimed Itauma had TKO'd Dubois at Wembley on a
 * specific date. The bot built a fully fabricated 1,800-char
 * narrative on that single outlier, ignoring the 14 contradicting
 * sources, and even invented details not in any of them ("90,000
 * draped in Union Jacks", "left hook to the temple at 2:12").
 */
const CONSENSUS_RULE = [
  'Read the sources as a group, not one at a time. When sources disagree, the majority wins:',
  '- A claim supported by ONLY one source while contradicted by several others is unreliable. Do not build confident statements on an outlier. Say what most sources agree on, or surface the disagreement honestly ("most reporting says X, though one source claims Y").',
  '- Pay attention to what most sources DO NOT say. If you are about to claim a dramatic event (a fight result, a death, a specific date, a quoted statement) and only one out of many sources mentions it, treat that as a red flag — content-farm or fabricated articles can produce such matches.',
  '- Never invent details (named bodyguards, crowd size, specific punches, exact times, quoted reactions) that no source explicitly states, even if it would make the answer more vivid. Vividness is not worth fabrication.',
  '',
  'EXISTENCE BEFORE DETAILS — the absent-entity rule:',
  '- Before describing or attributing anything about a person, place, work, event, organisation, or any other named entity the user has asked about, first check: does any source in the <search_results> block actually mention that entity by name? If NO source mentions it, the entity may not exist, may be fictional, or may be misspelled. In that case your answer MUST lead with that: "I cannot find any source that mentions <entity>. It may be fictional, misnamed, or simply not covered by these results." Do NOT invent an attribution, a fictional-universe origin, a creator, or any other plausible-sounding contextualisation. Plausible is not the same as supported.',
  '- This applies even when the named entity has the shape of a real thing (a city-sounding name, a person-sounding name, a book-sounding title). Shape is not evidence; sources are.',
].join('\n');

/**
 * Slim classifier system message (~250 tokens). The classifier's only
 * job is to emit one or more [command="..."] tags; it doesn't need
 * the persona, the events briefing, the experience lessons, or any
 * of the answer-round rules. Earlier versions of this prompt were
 * 700+ tokens of command syntax with multiple worked examples, on
 * top of ~1000 tokens of persona biography — total classifier prompt
 * ran 3.5K-4.5K tokens, which is ~10-30s of prompt-processing
 * latency on a 14B local model before any output. The slim version
 * brings the classifier turn back under 1-2s.
 *
 * `thinkingSupported` gates the THINKING command bullet: ministral-3:14b
 * does not support chain-of-thought, so advertising the command would
 * just waste tokens and risk the classifier emitting an unhonorable tag.
 */
function classifierInstructions(thinkingSupported: boolean): string {
  const commands = [
    '- [command="SEARCH"][search_prompt="A"][search_prompt="B"][search_prompt="C"][keywords="word1, word2, word3"] — web search. Use for factual / current-events / "right now" questions. Emit 1-3 [search_prompt] tags; multiple tags fan out in parallel. Each prompt is a complete standalone query in the user\'s language. Alongside SEARCH you MUST also emit ONE [keywords="..."] tag with 3-6 comma-separated discriminative words in the same language as the prompts (names, places, entities, technical terms — NOT stopwords). The orchestrator deterministically drops any retrieved snippet that contains none of these keywords, so pick words you really expect to appear in an on-topic result. If even one keyword shows up in a snippet, the snippet is kept.',
    ...(thinkingSupported
      ? [
          '- [command="THINKING"] — enable chain-of-thought for the answer round. Use for complex multi-step reasoning.',
        ]
      : []),
    '- [command="DIRECT"] — answer directly, no search. Use for chitchat, greetings, opinions, self/persona questions, anything introspective.',
    '- [command="LOCATION"][search_prompt="..."] — look up a place OTHER than the user\'s own (the user\'s location is already known).',
    '- [command="DATE_TIME"][search_prompt="..."] — look up date/time for somewhere/something OTHER than the user (different timezone, historical event).',
  ];
  const chaining = thinkingSupported
    ? 'Chain commands as [command="THINKING, SEARCH"][search_prompt="..."].'
    : 'Chain commands as [command="SEARCH, LOCATION"][search_prompt="..."] when more than one applies.';
  return [
    'You are a routing classifier for a chatbot. Output ONLY command tag(s) — no prose, no persona voice, no explanation.',
    '',
    'Wrap your output in [__meta_section__]...[/__meta_section__].',
    '',
    'Available commands:',
    ...commands,
    '',
    chaining,
    '',
    "Language rule: detect the language of the user's last message and write any [search_prompt] in that exact language. Do NOT add language flavour, asides, or persona voice — output only tags.",
    '',
    "Date/location: the user's dateTime and location (when known) are pre-injected in the user message and do NOT require LOCATION/DATE_TIME commands. Include the date in [search_prompt] only when the answer truly depends on it (today's news, opening hours, what is airing now); skip it for biographical / historical / scientific / general factual queries.",
  ].join('\n');
}

export function buildAssessmentPrompt(args: {
  userText: string;
  cityCountry: string | null;
  dateTime: string;
  /**
   * Compact pronoun-resolution hint built by the caller from the last
   * 1-2 turn pairs, token-budgeted. See ReverseControlFlowService.
   */
  recentHistoryBlock: string | null;
  /** Whether the answer model supports chain-of-thought. Gates the
   *  THINKING command bullet. */
  thinkingSupported: boolean;
}): LlmMessage[] {
  // Classifier prompt is deliberately slim. No persona, no lessons,
  // no briefing, no answer-round rules. The model has one job: emit
  // command tags. See classifierInstructions() for the full spec.
  const systemContent = classifierInstructions(args.thinkingSupported);

  const userParts: string[] = [
    '[__meta_section__]',
    userContextLine(args),
  ];

  if (args.recentHistoryBlock) {
    userParts.push('', `Last user turn(s): ${args.recentHistoryBlock}`);
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
/**
 * The user-profiling subsystem (user_identities, app_identities,
 * experience_lessons) was deleted: the LLM extractor produced
 * hallucinated, cross-persona, language-overriding "facts" that
 * leaked between sessions. Only the session-summary path remains,
 * which is per-session and contained.
 */
export interface FragmentedContextInput {
  /**
   * Returns the largest stored session summary with `through_seq`
   * strictly less than `beforeSeq` (so the summary covers messages
   * older than the raw hot zone — no overlap). When `beforeSeq` is
   * null, returns the most recent summary regardless of cutoff (used
   * as the last-resort fallback when the orchestrator needs *some*
   * summary but doesn't have a clean hot-zone-start to bound by).
   * Returns null when no summary exists at all.
   *
   * Lazy by design: the orchestrator only knows which cutoff it
   * needs after the budget walk decides which messages stay raw.
   */
  fetchSummaryUpTo: (beforeSeq: number | null) => SessionSummaryHit | null;
}

export interface BuildAnswerPromptDiagnostics {
  /** Tokens used by the mandatory parts (persona + rules + identity + search + current user msg). */
  mandatoryTokens: number;
  /** Tokens used by raw history actually included. */
  historyTokens: number;
  /** Tokens used by the session summary, when included (0 otherwise). */
  summaryTokens: number;
  /** True if budget required dropping oldest history in favour of the summary. */
  summaryIncluded: boolean;
  /** How many history messages were dropped (0 when everything fits raw). */
  historyDropped: number;
  /** Through-seq of the summary actually used, or null when no summary was needed. */
  summaryThroughSeq: number | null;
  /** Total prompt tokens after assembly. */
  totalPromptTokens: number;
  /** Budget the caller passed in. */
  promptBudgetTokens: number;
  /** True if the total_token_count fast path skipped per-message iteration. */
  fastPath: boolean;
}

export function buildAnswerPrompt(args: {
  userText: string;
  cityCountry: string | null;
  dateTime: string;
  fulfilledContext: string | null;
  /** ALL conversation history for this session, oldest-first. NOT pre-sliced. */
  history: HistoryTurn[];
  personaSystemPrompt: string | null;
  fragmentedContext?: FragmentedContextInput;
  /** Max prompt tokens — the LLM host's computed budget. */
  promptBudgetTokens: number;
  /**
   * Running content-token count from `sessions.total_token_count`. Used
   * as a fast-path estimate to avoid iterating per-message tokens when
   * the session clearly fits raw in the budget. 0 for sessions that
   * predate the column — the slow path handles those correctly.
   */
  sessionTotalTokens: number;
  /** Optional diagnostics sink for logging the assembly decisions. */
  diagnostics?: (d: BuildAnswerPromptDiagnostics) => void;
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
  // --- 1. Build the always-mandatory parts as discrete system messages ---

  const systemParts: string[] = [];
  // LANGUAGE_RULE is FIRST, unconditionally — before persona, before
  // context, before any rule cluster. Small models weight the first
  // system paragraph most heavily; the persona prose runs 700-1000
  // tokens and will out-vote anything pushed after it. We hit this
  // exact failure in production: a Romanian user query to
  // Italian-flavored Marcello produced an Italian answer because the
  // persona's voice anchored the language slot first.
  systemParts.push(LANGUAGE_RULE);
  if (args.personaSystemPrompt) systemParts.push(args.personaSystemPrompt);
  // Always make the answering model aware of when/where the user is.
  systemParts.push(buildAnswerContextBlock(args.cityCountry, args.dateTime));
  if (args.fulfilledContext) {
    // CONSENSUS_RULE before ELABORATION_RULE. Interpretation comes
    // before composition: decide what to believe from the sources,
    // then decide how much to write about it. Reversing this lets the
    // model elaborate first and consensus-check second, which is when
    // outlier-source narratives slip through.
    systemParts.push(CONSENSUS_RULE);
    systemParts.push(ELABORATION_RULE);
  }
  // Last position, after persona and rules — anchors the language
  // slot at both edges so the persona's voice can't pull the model
  // into a non-target language.
  systemParts.push(LANGUAGE_RULE_REMINDER);

  const mandatorySystemMessages: LlmMessage[] = [];
  if (systemParts.length > 0) {
    mandatorySystemMessages.push({
      role: 'system',
      content: systemParts.join('\n\n'),
    });
  }

  // (Durable identity facts injection removed — see the deletion of
  // renderIdentityOnlyBlock below.)

  // Search/lookup results: separate system message so the model sees
  // them as ground-truth runtime context, not as user-pasted content.
  if (args.fulfilledContext) {
    mandatorySystemMessages.push({
      role: 'system',
      content: `Information gathered for this turn:\n${args.fulfilledContext}`,
    });
  }

  // Per-turn language hint: detect the user's language server-side and
  // inject a binding system message just before the user turn. This
  // is the LAST system instruction the model reads before the user
  // text, which gives it the strongest weight against the
  // "treat short foreign-language messages as quotes in the current
  // language" failure mode. detectLanguageHint returns null on
  // uncertain input (biases to English by default).
  const languageHint = detectLanguageHint(args.userText);
  if (languageHint) {
    mandatorySystemMessages.push({ role: 'system', content: languageHint });
  }

  const currentUserMessage: LlmMessage = {
    role: 'user',
    content: args.userText,
  };

  // --- 2. Compute tokens for mandatory parts ---

  const mandatoryTokens =
    mandatorySystemMessages.reduce(
      (sum, m) => sum + tokensForText(m.content),
      0,
    ) + tokensForText(currentUserMessage.content);

  // --- 3. Fast path: if sessions.total_token_count tells us the
  //        history fits comfortably, skip per-message iteration. ---

  const perMessageOverheadBudget =
    PER_MESSAGE_TOKEN_OVERHEAD * args.history.length;

  // Note: sessionTotalTokens is the running content-token sum kept by
  // ChatSessionService.appendTurn. 0 means "either an empty session
  // OR a pre-Unit-J session before the column was migrated" — for
  // both cases the slow path below is correct.
  const fastPathTotalEstimate =
    args.sessionTotalTokens > 0
      ? args.sessionTotalTokens + perMessageOverheadBudget
      : null;

  const fastPathFits =
    fastPathTotalEstimate !== null &&
    mandatoryTokens + fastPathTotalEstimate <= args.promptBudgetTokens;

  if (fastPathFits) {
    // Whole session fits raw, no summary required. Skip per-message
    // tokenisation entirely — we just push messages through.
    const messages: LlmMessage[] = [
      ...mandatorySystemMessages,
      ...args.history.map<LlmMessage>((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      currentUserMessage,
    ];

    if (args.diagnostics) {
      args.diagnostics({
        mandatoryTokens,
        historyTokens: fastPathTotalEstimate as number,
        summaryTokens: 0,
        summaryIncluded: false,
        summaryThroughSeq: null,
        historyDropped: 0,
        totalPromptTokens:
          mandatoryTokens + (fastPathTotalEstimate as number),
        promptBudgetTokens: args.promptBudgetTokens,
        fastPath: true,
      });
    }
    return messages;
  }

  // --- 4. Slow path: per-message token estimate + budget-driven walk ---

  const historyWithTokens = args.history.map((turn) => ({
    turn,
    msg: { role: turn.role, content: turn.content } as LlmMessage,
    tokens: tokensForText(turn.content),
  }));
  const totalHistoryTokens = historyWithTokens.reduce(
    (sum, x) => sum + x.tokens,
    0,
  );

  let includedHistory: LlmMessage[];
  let summaryIncluded = false;
  let summaryMessage: LlmMessage | null = null;
  let summaryTokens = 0;
  let summaryThroughSeq: number | null = null;
  let historyDropped = 0;
  let usedHistoryTokens = 0;

  if (mandatoryTokens + totalHistoryTokens <= args.promptBudgetTokens) {
    // Everything fits raw. No summary needed.
    includedHistory = historyWithTokens.map((x) => x.msg);
    usedHistoryTokens = totalHistoryTokens;
  } else {
    // Overflow. Walk newest-first up to a tentative budget that
    // assumes a summary will be included (its size unknown until we
    // know the cutoff). We over-reserve a placeholder for the
    // summary, then refine once the fragmenter returns one.
    const remainingForRaw = args.promptBudgetTokens - mandatoryTokens;
    const tentative = walkHistoryNewestFirst(
      historyWithTokens,
      remainingForRaw,
    );

    // The oldest message we kept raw — anything older than this must
    // be summarised away (or simply dropped if no summary covers it).
    const oldestKeptSeq =
      tentative.kept.length > 0
        ? tentative.kept[0].turn.seq
        : null;

    // Ask the fragmenter for a summary covering messages strictly
    // older than what we kept raw. If we kept nothing raw (budget too
    // tight), ask for the most recent summary regardless of cutoff.
    const summaryHit =
      args.fragmentedContext?.fetchSummaryUpTo(oldestKeptSeq) ?? null;

    if (summaryHit) {
      summaryMessage = {
        role: 'system',
        content:
          `Summary of earlier turns in this session (covering messages 1..${summaryHit.throughSeq}, older than the raw messages shown below):\n` +
          summaryHit.summary +
          '\n\n' +
          STRUCTURAL_AWARENESS_RULE,
      };
      summaryTokens = tokensForText(summaryMessage.content);
      summaryThroughSeq = summaryHit.throughSeq;
      summaryIncluded = true;

      // Re-walk with the actual summary cost reserved, AND drop any
      // raw messages with seq <= summaryThroughSeq so the summary's
      // coverage and the raw tail don't overlap.
      const tighter = walkHistoryNewestFirst(
        historyWithTokens.filter((x) => x.turn.seq > summaryHit.throughSeq),
        args.promptBudgetTokens - mandatoryTokens - summaryTokens,
      );
      includedHistory = tighter.kept.map((x) => x.msg);
      usedHistoryTokens = tighter.usedTokens;
      historyDropped = args.history.length - tighter.kept.length;
    } else {
      // No summary available — keep the tentative raw walk and
      // accept the lost old turns (the bot will have a gap in
      // memory between the dropped messages and what it sees).
      includedHistory = tentative.kept.map((x) => x.msg);
      usedHistoryTokens = tentative.usedTokens;
      historyDropped = tentative.droppedCount;
    }
  }

  // --- 5. Assemble final message list in the right order ---

  const messages: LlmMessage[] = [...mandatorySystemMessages];
  if (summaryIncluded && summaryMessage) {
    // Summary slots between identity/rules and the raw history block.
    // The model reads it as background covering turns older than the
    // raw block — and because we trimmed raw to seq > summaryThroughSeq,
    // there is no overlap.
    messages.push(summaryMessage);
  }
  messages.push(...includedHistory);
  messages.push(currentUserMessage);

  if (args.diagnostics) {
    const totalPromptTokens =
      mandatoryTokens +
      (summaryIncluded ? summaryTokens : 0) +
      usedHistoryTokens;
    args.diagnostics({
      mandatoryTokens,
      historyTokens: usedHistoryTokens,
      summaryTokens: summaryIncluded ? summaryTokens : 0,
      summaryIncluded,
      summaryThroughSeq,
      historyDropped,
      totalPromptTokens,
      promptBudgetTokens: args.promptBudgetTokens,
      fastPath: false,
    });
  }

  return messages;
}

interface HistoryWithTokens {
  turn: HistoryTurn;
  msg: LlmMessage;
  tokens: number;
}

/**
 * Walks history newest-first, accumulating messages whose total
 * estimated tokens fit within `budgetTokens`. Returns the kept
 * entries in the original (oldest-first) order so the alternating
 * user/assistant sequence reads naturally to the model.
 *
 * Operates on pre-tokenised entries to avoid re-estimating in the
 * slow path. Returns the entries (not just messages) so the caller
 * can correlate seqs for the per-cutoff summary lookup.
 */
function walkHistoryNewestFirst(
  history: HistoryWithTokens[],
  budgetTokens: number,
): { kept: HistoryWithTokens[]; droppedCount: number; usedTokens: number } {
  if (budgetTokens <= 0) {
    return { kept: [], droppedCount: history.length, usedTokens: 0 };
  }
  const kept: HistoryWithTokens[] = [];
  let usedTokens = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (usedTokens + entry.tokens > budgetTokens) break;
    kept.push(entry);
    usedTokens += entry.tokens;
  }
  return {
    kept: kept.reverse(),
    droppedCount: history.length - kept.length,
    usedTokens,
  };
}

// renderIdentityOnlyBlock removed: the user-profiling subsystem
// (durable identity facts about user / assistant / experience
// lessons) is gone. It produced cross-persona, cross-session,
// language-overriding bullet points that the model treated as
// authoritative and used to override LANGUAGE_RULE.
