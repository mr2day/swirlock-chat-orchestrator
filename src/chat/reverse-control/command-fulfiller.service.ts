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

      // Feed the top BODY_SOURCE_COUNT sources' full bodies to the
      // answer round (capped at PER_SOURCE_BODY_CAP chars each so the
      // total stays inside ministral's ~26K prompt budget). Sources
      // beyond that still ride along as title+URL only. Motivating
      // incident: TVR1/Eurovision turn — the Eurovision-Final entry
      // sat in the BODY of Source 3 ("Program TVR 1 16.05.2026"),
      // not in Source 1's body or any source's title. Feeding only
      // Source 1's body blinded the model to it.
      const BODY_SOURCE_COUNT = 5;
      const PER_SOURCE_BODY_CAP = 10000;
      const bodied = merged.slice(0, BODY_SOURCE_COUNT);
      const titleOnly = merged.slice(BODY_SOURCE_COUNT);

      const bodiedBlocks = bodied.map((ev, i) => {
        const raw = (ev.snippet ?? '').trim();
        const capped =
          raw.length <= PER_SOURCE_BODY_CAP
            ? raw
            : `${raw.slice(0, PER_SOURCE_BODY_CAP - 3).trimEnd()}...`;
        const header = `[Source ${i + 1}] ${ev.sourceTitle}`;
        return capped ? `${header}\n${capped}` : `${header} (no extractable body)`;
      });

      const titleOnlyBlock =
        titleOnly.length > 0
          ? '\n\nAdditional sources returned across this fan-out (title + URL only; full body not loaded — the user can open them from the citation panel):\n' +
            titleOnly
              .map(
                (ev, i) =>
                  `- [Source ${BODY_SOURCE_COUNT + i + 1}] ${ev.sourceTitle} — ${ev.sourceUrl ?? '(no url)'}`,
              )
              .join('\n')
          : '';

      const groundingRule = [
        'GROUNDING RULES (apply these strictly to factual claims; persona voice / asides / opinions / recommendations are unaffected):',
        '',
        '1. Before naming ANY specific show, movie, programme, time, person, place, or numeric detail, check: is this exact string visibly present somewhere in the source bodies above? If not, you may NOT name it. This includes plausible-sounding TV shows that "feel right" (e.g. Indian serials, Turkish dramas, daily news bulletins) — if the title is not in any source body, do not write it.',
        '',
        '2. Read ACROSS all the source bodies, not just the first one. If the user\'s question is about "what is airing right now" and the first source\'s schedule starts at a time later than now, check the other source bodies for an entry that covers the current moment (a live broadcast spanning midnight, a special event running into the small hours). Cross-day live events often appear in a different source than the daily-schedule page.',
        '',
        '3. If no source body covers the time, topic, or detail the user is asking about, say so plainly. Do NOT substitute a plausible-sounding guess ("probably a commercial loop", "perhaps the news", "likely a Turkish serial"). "I don\'t know what\'s airing right now from these sources" is the correct answer when all sources are silent on the specific question.',
        '',
        '4. Truncation or absence in the sources is not evidence about the real world. Do not promote the nearest visible entry from one source to fill a gap that another source might fill correctly.',
        '',
        '5. If one of the title-only sources looks directly relevant to what the user asked (its title alone is the clue), tell the user that source is available in the citation panel. Do NOT fabricate the contents of title-only sources — you have only their titles and URLs.',
        '',
        '6. Recommendations and opinions are fine ("you might enjoy a Visconti film tonight", "I\'d skip the late-night devotionals if I were you") as long as they are clearly subjective and not presented as facts about the schedule.',
      ].join('\n');

      const queryLabel = queries.length === 1
        ? `Search query: "${queries[0]}"`
        : `Search fan-out (${queries.length} parallel queries): ${queries.map((q) => `"${q}"`).join(', ')}`;
      const value = `${queryLabel} — top ${bodied.length} result${bodied.length === 1 ? '' : 's'} (full bodies below):\n\n${bodiedBlocks.join('\n\n')}${titleOnlyBlock}\n\n${groundingRule}`;
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
