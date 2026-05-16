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
      case 'SEARCH':
        return this.fulfillSearch(command, parsed.searchPrompt, ctx, knownLocation);

      case 'THINKING':
      case 'DIRECT':
        return { command, value: '' };
    }
  }

  private async fulfillSearch(
    label: CommandKind,
    searchPrompt: string | undefined,
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    const query = searchPrompt?.trim() || ctx.userText.trim();
    if (!searchPrompt) {
      this.log.warn(
        `${label} command emitted without a [search_prompt="..."] tag; falling back to userText.`,
      );
    }

    try {
      const result = await this.rag.retrieve({
        correlationId: ctx.correlationId,
        sessionId: ctx.sessionId,
        userText: ctx.userText,
        parts: [{ type: 'text', text: query }],
        resolvedQueryText: query,
        freshness: this.cfg.rag.freshness,
        allowedModes: [...this.cfg.rag.allowedModes],
        ...(knownLocation ? { userLocation: knownLocation } : {}),
        onStreamEvent: ctx.onRetrievalStreamEvent,
        abortSignal: ctx.abortSignal,
      });

      if (result.evidence.length === 0) {
        return {
          command: label,
          value: `Search query "${query}" returned no results.`,
          evidence: [],
        };
      }

      // Single-pass pattern: feed the top Exa result's full extracted
      // text directly to the answer round. No second-LLM distillation,
      // no per-source clipping. The body text comes through uncapped
      // (up to Exa's own ceiling, currently text.maxCharacters=24000).
      const top = result.evidence[0];
      const body = top.snippet?.trim() ?? '';
      const groundingRule =
        'When you answer, use only facts visibly present in the source above. If the source does not cover the specific time, topic, or detail the user is asking about, say so plainly — do not promote the nearest visible entry to fill the gap. Truncation or absence in the source is not evidence about the real world.';
      const value = body
        ? `Search query: "${query}" — top result:\n[Source 1] ${top.sourceTitle}\n${body}\n\n${groundingRule}`
        : `Search query: "${query}" — top result: ${top.sourceTitle} (no extractable body)\n\n${groundingRule}`;
      return {
        command: label,
        value,
        evidence: [top],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`${label} search fulfillment failed: ${message}`);
      return {
        command: label,
        value: `Search for "${query}" failed: ${message}`,
      };
    }
  }
}
