import { Inject, Injectable, Logger } from '@nestjs/common';
import { SERVICE_CONFIG } from '../../config/config';
import type { ServiceConfig } from '../../config/config';
import { RagService } from '../../rag/rag.service';
import type { RetrievalStreamEvent, UserLocation } from '../../rag/rag.service';
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
        };
      }

      const lines: string[] = [
        `Search query: "${query}" — ${result.evidence.length} result${result.evidence.length === 1 ? '' : 's'}:`,
      ];
      for (const ev of result.evidence.slice(0, 8)) {
        const url = ev.sourceUrl ? ` (${ev.sourceUrl})` : '';
        const snippet = ev.snippet ? `: ${ev.snippet}` : '';
        lines.push(`- ${ev.sourceTitle}${url}${snippet}`);
      }
      return { command: label, value: lines.join('\n') };
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
