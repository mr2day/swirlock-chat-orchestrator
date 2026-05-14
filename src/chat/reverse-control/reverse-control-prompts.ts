import type { LlmMessage } from '../../llm-host/llm-host.service';
import { estimateTokens } from '../utils/token-estimator';

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
export interface FragmentedContextInput {
  userIdentity: Array<{
    content: string;
    importance: 'core' | 'important' | 'incidental';
  }>;
  appIdentity: Array<{
    content: string;
    importance: 'core' | 'important' | 'incidental';
  }>;
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
  if (args.personaSystemPrompt) systemParts.push(args.personaSystemPrompt);
  // Always make the answering model aware of when/where the user is.
  systemParts.push(buildAnswerContextBlock(args.cityCountry, args.dateTime));
  if (args.fulfilledContext) {
    // LANGUAGE_RULE before ELABORATION_RULE — small models weight the
    // first system-message rule most heavily, so the language directive
    // needs the top slot.
    systemParts.push(LANGUAGE_RULE);
    systemParts.push(ELABORATION_RULE);
  }

  const mandatorySystemMessages: LlmMessage[] = [];
  if (systemParts.length > 0) {
    mandatorySystemMessages.push({
      role: 'system',
      content: systemParts.join('\n\n'),
    });
  }

  // Durable identity facts (user + persona). Always included — these
  // are small, always relevant, and cheap to include.
  const identityBlock = renderIdentityOnlyBlock(args.fragmentedContext);
  if (identityBlock) {
    mandatorySystemMessages.push({ role: 'system', content: identityBlock });
  }

  // Search/lookup results: separate system message so the model sees
  // them as ground-truth runtime context, not as user-pasted content.
  if (args.fulfilledContext) {
    mandatorySystemMessages.push({
      role: 'system',
      content: `Information gathered for this turn:\n${args.fulfilledContext}`,
    });
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
          summaryHit.summary,
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

/**
 * Renders the durable-identity portion of the fragmented context
 * (user identity facts + persona identity facts). The session
 * summary is intentionally NOT included here — the new prompt
 * assembly handles the summary as a conditional, budget-driven
 * block in its own system message, so identity and summary are
 * decoupled.
 */
function renderIdentityOnlyBlock(
  ctx: FragmentedContextInput | undefined,
): string | null {
  if (!ctx) return null;
  const hasUser = ctx.userIdentity.length > 0;
  const hasApp = ctx.appIdentity.length > 0;
  if (!hasUser && !hasApp) return null;

  const lines: string[] = ['Durable memory carried across turns:'];

  if (hasUser) {
    lines.push('', 'What you know about the user (durable facts):');
    for (const fact of ctx.userIdentity) {
      lines.push(`- [${fact.importance}] ${fact.content}`);
    }
  }

  if (hasApp) {
    lines.push('', 'What you know about yourself (durable facts):');
    for (const fact of ctx.appIdentity) {
      lines.push(`- [${fact.importance}] ${fact.content}`);
    }
  }

  return lines.join('\n');
}
