import { Inject, Injectable, Logger } from '@nestjs/common';
import { SERVICE_CONFIG } from '../../config/config';
import type { ServiceConfig } from '../../config/config';
import { RagService } from '../../rag/rag.service';
import type {
  RagEvidence,
  RetrievalStreamEvent,
  UserLocation,
} from '../../rag/rag.service';
import type { CommandKind, ParsedCommands } from './command-parser';

export interface FulfillContext {
  correlationId: string;
  sessionId: string;
  userText: string;
  occurredAt: string;
  abortSignal: AbortSignal;
  initialLocation: UserLocation | undefined;
  resolveUserLocation: () => Promise<UserLocation | null>;
  onRetrievalStreamEvent: (event: RetrievalStreamEvent) => void;
}

export interface FulfillmentResult {
  command: CommandKind;
  value: string;
  patch?: { location?: UserLocation };
  /** Evidence pulled by RAG (if any), to be propagated as citations. */
  evidence?: RagEvidence[];
}

/**
 * One leg of the SEARCH fan-out's result. Beyond evidence, carries the
 * RAG diagnostics blob (which includes any upstream provider error like
 * Exa's "credits exhausted" message) plus a transport-level error
 * captured when the RAG call itself failed (network, timeout). Either
 * of those is bubbled into the SEARCH result string when every leg
 * comes back empty, so the model can tell the user what actually
 * happened instead of silently confabulating an ungrounded answer.
 */
interface FanoutLegResult {
  query: string;
  evidence: RagEvidence[];
  diagnostics?: Record<string, unknown>;
  transportError?: string;
}

/**
 * Returns the first non-empty upstream search-provider failure
 * message across the fan-out legs, or null when every leg either
 * returned successfully (with zero matches) or carried no diagnostic
 * indication of failure.
 *
 * RAG engine reports the upstream Exa error as
 * `diagnostics.liveSearchError` (string). A failure on the orchestrator
 * ↔ RAG transport itself surfaces as the leg's `transportError`.
 */
function extractProviderFailureMessage(
  fanout: FanoutLegResult[],
): string | null {
  for (const leg of fanout) {
    if (typeof leg.transportError === 'string' && leg.transportError.trim()) {
      return leg.transportError.trim();
    }
    const diag = leg.diagnostics as
      | { liveSearchError?: unknown; warnings?: unknown }
      | undefined;
    const liveErr = diag?.liveSearchError;
    if (typeof liveErr === 'string' && liveErr.trim()) {
      return liveErr.trim();
    }
    if (Array.isArray(diag?.warnings)) {
      for (const w of diag.warnings) {
        if (typeof w === 'string' && w.trim()) {
          return w.trim();
        }
      }
    }
  }
  return null;
}

/**
 * Dispatches each parsed command to its handler.
 *
 * In the new pre-inject regime, the user's location and dateTime are
 * already in the meta-section, so bare LOCATION/DATE_TIME commands are
 * filtered out by the flow service before reaching us. What lands here
 * is always a web-search request:
 *
 *   - SEARCH                                  → RAG search (label SEARCH)
 *   - LOCATION  + [search_prompt="..."]       → RAG search (label LOCATION)
 *   - DATE_TIME + [search_prompt="..."]       → RAG search (label DATE_TIME)
 *
 * THINKING and DIRECT are flags handled in the flow service, not here.
 */
@Injectable()
export class CommandFulfillerService {
  private readonly log = new Logger(CommandFulfillerService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly rag: RagService,
  ) {}

  async fulfill(
    command: CommandKind,
    parsed: ParsedCommands,
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    switch (command) {
      case 'LOCATION':
      case 'DATE_TIME':
        return this.fulfillSearch(
          command,
          parsed,
          parsed.searchPrompt ? [parsed.searchPrompt] : [],
          ctx,
          knownLocation,
        );

      case 'SEARCH':
        return this.fulfillSearch(
          command,
          parsed,
          parsed.searchPrompts ?? (parsed.searchPrompt ? [parsed.searchPrompt] : []),
          ctx,
          knownLocation,
        );

      case 'THINKING':
      case 'DIRECT':
        return { command, value: '' };
    }
  }

  private async fulfillSearch(
    label: CommandKind,
    parsed: ParsedCommands,
    searchPrompts: string[],
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    // Always include the user's RAW text as the first fan-out leg.
    // The classifier's rewrites sometimes narrow the query and drop
    // the page that actually answers the question — e.g. on the TVR1
    // turn the user typed "ce e la TVR1 in momentul asta?" and the
    // raw form surfaced yesterday's TVR1 schedule (which had the
    // Eurovision Final entry that ran past midnight), while the
    // classifier's "17 mai 2026 ora 02:22"-anchored rewrites pushed
    // that page out. Keep the raw query as a baseline; let the
    // rewrites add coverage, not replace it.
    const rawQuery = ctx.userText.trim();
    const rewrites = searchPrompts
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => p.toLowerCase() !== rawQuery.toLowerCase());
    const queries = rawQuery
      ? [rawQuery, ...rewrites].slice(0, 4)
      : rewrites.slice(0, 3);
    if (searchPrompts.length === 0) {
      this.log.warn(
        `${label} command emitted without any [search_prompt="..."] tag; running fan-out with the raw user query alone.`,
      );
    }

    try {
      // Parallel fan-out: fire one RAG retrieve per query angle. The
      // RAG Engine handles each request concurrently. Each leg gets a
      // unique correlationId (the turn correlation + a leg suffix) —
      // the orchestrator's persistent RAG socket keys pending requests
      // by correlationId, so reusing the turn id across legs would
      // overwrite each leg's resolver and only the last one would ever
      // settle, hanging Promise.all forever. We merge by URL afterwards.
      const fanout: FanoutLegResult[] = await Promise.all(
        queries.map((q, idx) =>
          this.rag
            .retrieve({
              correlationId: `${ctx.correlationId}:leg${idx}`,
              sessionId: ctx.sessionId,
              userText: ctx.userText,
              parts: [{ type: 'text', text: q }],
              resolvedQueryText: q,
              freshness: this.cfg.rag.freshness,
              allowedModes: [...this.cfg.rag.allowedModes],
              ...(knownLocation ? { userLocation: knownLocation } : {}),
              onStreamEvent: ctx.onRetrievalStreamEvent,
              abortSignal: ctx.abortSignal,
            })
            .then(
              (res): FanoutLegResult => ({
                query: q,
                evidence: res.evidence,
                diagnostics: res.diagnostics,
              }),
            )
            .catch((err: Error): FanoutLegResult => {
              this.log.warn(
                `${label} fan-out leg "${q}" failed: ${err.message}`,
              );
              return { query: q, evidence: [], transportError: err.message };
            }),
        ),
      );

      const merged = this.dedupeAcrossFanout(fanout);

      if (merged.length === 0) {
        // No evidence came back. Distinguish "search ran cleanly and
        // found nothing" from "search provider failed" — the model
        // shouldn't silently make up an answer when the upstream
        // search has actually broken. The former passes through as
        // "Search returned no results." (pre-existing behaviour);
        // the latter surfaces the upstream error so the model can
        // tell the user what's wrong instead of confabulating.
        const providerError = extractProviderFailureMessage(fanout);
        return {
          command: label,
          value:
            providerError !== null
              ? `Web search failed: ${providerError}. Tell the user the web search isn't working right now (and quote the specific cause when it points at a billing / credits / quota issue). Do not invent facts that would have come from a real search.`
              : 'Search returned no results.',
          evidence: [],
        };
      }

      // Deterministic keyword filter: the classifier emits
      // [keywords="..."] alongside SEARCH. We keep only snippets
      // whose stripped prose contains at least one keyword
      // (case-insensitive substring). The model never sees titles
      // or URLs — only the kept prose, wrapped in <result>.
      const keywords = parsed.keywords ?? [];
      if (keywords.length === 0) {
        this.log.warn(
          `${label} fulfilled without [keywords="..."]; the keyword filter is a no-op for this turn.`,
        );
      }

      const PER_RESULT_CAP = 10000;
      const kept: Array<{ ev: RagEvidence; prose: string }> = [];
      for (const ev of merged) {
        const prose = this.toProse(ev.snippet ?? '');
        if (!prose) continue;
        if (keywords.length > 0 && !this.matchesAnyKeyword(prose, keywords)) {
          continue;
        }
        const capped =
          prose.length <= PER_RESULT_CAP
            ? prose
            : `${prose.slice(0, PER_RESULT_CAP - 3).trimEnd()}...`;
        kept.push({ ev, prose: capped });
      }

      if (kept.length === 0) {
        return {
          command: label,
          value: 'Search returned no on-topic results.',
          evidence: [],
        };
      }

      const resultBlocks = kept
        .map(({ prose }) => `<result>\n${prose}\n</result>`)
        .join('\n\n');
      const value = `<search_results>\n${resultBlocks}\n</search_results>`;

      return {
        command: label,
        value,
        evidence: kept.map((k) => k.ev),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`${label} search fulfillment failed: ${message}`);
      return {
        command: label,
        value: `Search for "${queries.join(' / ')}" failed: ${message}`,
      };
    }
  }

  /**
   * Cleans a retrieved snippet into bare prose suitable for the
   * answer-round prompt. Strips HTML tags (Brave wraps highlighted
   * terms in <strong>...</strong>), decodes the common entities,
   * removes embedded URLs (we never want URLs in the model's input
   * for search results — they leak hostnames and SEO bait), and
   * collapses whitespace.
   */
  private toProse(snippet: string): string {
    let t = snippet;
    t = t.replace(/<[^>]+>/g, ' ');
    t = t
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
    t = t.replace(/https?:\/\/\S+/gi, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  /**
   * ANY-keyword match, case-insensitive substring. The keyword list
   * is small (3-6 entries by classifier spec); we lowercase the
   * prose once and test each keyword in turn.
   */
  private matchesAnyKeyword(prose: string, keywords: string[]): boolean {
    const haystack = prose.toLowerCase();
    for (const kw of keywords) {
      const needle = kw.toLowerCase().trim();
      if (!needle) continue;
      if (haystack.includes(needle)) return true;
    }
    return false;
  }

  /**
   * Merge evidence arrays from a parallel fan-out, deduping by URL.
   * Preserves the order in which URLs first appeared across the
   * fan-out legs (so leg 0's top hit becomes Source 1, etc.).
   */
  private dedupeAcrossFanout(
    fanout: Array<{ query: string; evidence: RagEvidence[] }>,
  ): RagEvidence[] {
    const seen = new Set<string>();
    const merged: RagEvidence[] = [];
    // Interleave: take leg 0's #1, leg 1's #1, leg 2's #1, then leg 0's #2,
    // leg 1's #2, etc. So each leg contributes its best hits to the top
    // of the merged list — better than concatenating "all of leg 0, then
    // all of leg 1" which would let one leg's tail outrank another's head.
    const maxLen = Math.max(...fanout.map((f) => f.evidence.length), 0);
    for (let rank = 0; rank < maxLen; rank += 1) {
      for (const leg of fanout) {
        const ev = leg.evidence[rank];
        if (!ev) continue;
        const key = ev.sourceUrl ?? `__noUrl__::${ev.sourceTitle}::${ev.evidenceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(ev);
      }
    }
    return merged;
  }
}
