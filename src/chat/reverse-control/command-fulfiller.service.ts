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
          parsed.searchPrompt ? [parsed.searchPrompt] : [],
          ctx,
          knownLocation,
        );

      case 'SEARCH':
        return this.fulfillSearch(
          command,
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
    searchPrompts: string[],
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    const queries =
      searchPrompts.map((p) => p.trim()).filter(Boolean).length > 0
        ? searchPrompts.map((p) => p.trim()).filter(Boolean)
        : [ctx.userText.trim()];
    if (searchPrompts.length === 0) {
      this.log.warn(
        `${label} command emitted without any [search_prompt="..."] tag; falling back to userText.`,
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
      const fanout = await Promise.all(
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
            .then((res) => ({ query: q, evidence: res.evidence }))
            .catch((err: Error) => {
              this.log.warn(
                `${label} fan-out leg "${q}" failed: ${err.message}`,
              );
              return { query: q, evidence: [] };
            }),
        ),
      );

      const merged = this.dedupeAcrossFanout(fanout);

      if (merged.length === 0) {
        const joined = queries.map((q) => `"${q}"`).join(' / ');
        return {
          command: label,
          value: `Search ${joined} returned no results.`,
          evidence: [],
        };
      }

      // Source 1 gets its full body in the prompt. Sources 2..N ride
      // along as title+URL only so the model can spot a missed angle
      // and tell the user to open the citation panel.
      const top = merged[0];
      const body = top.snippet?.trim() ?? '';
      const others = merged.slice(1);
      const othersBlock =
        others.length > 0
          ? '\n\nOther sources also returned across this fan-out (title + URL only; full body not loaded — the user can open them from the citation panel):\n' +
            others
              .map(
                (ev, i) =>
                  `- [Source ${i + 2}] ${ev.sourceTitle} — ${ev.sourceUrl ?? '(no url)'}`,
              )
              .join('\n')
          : '';
      const groundingRule =
        'Be yourself in how you answer — voice, opinions, asides, recommendations are all welcome. But factual claims about the world (times, names, what is airing, what happened) must come from what is visibly present in Source 1 above. If Source 1 does not cover the specific thing the user is asking about, say so plainly — do not promote the nearest visible entry in Source 1 as the answer, and do not invent details to bridge a gap. Truncation or absence in Source 1 is not evidence about the real world. If one of the other listed sources has a title that looks directly relevant to what the user asked, tell the user that source is available in the citation panel — do not fabricate the contents of sources 2 onward, since you only have their titles and URLs, not their text.';

      const queryLabel = queries.length === 1
        ? `Search query: "${queries[0]}"`
        : `Search fan-out (${queries.length} parallel queries): ${queries.map((q) => `"${q}"`).join(', ')}`;
      const value = body
        ? `${queryLabel} — top result:\n[Source 1] ${top.sourceTitle}\n${body}${othersBlock}\n\n${groundingRule}`
        : `${queryLabel} — top result: ${top.sourceTitle} (no extractable body)${othersBlock}\n\n${groundingRule}`;
      return {
        command: label,
        value,
        evidence: merged,
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
