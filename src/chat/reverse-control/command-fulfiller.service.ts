import { Inject, Injectable, Logger } from '@nestjs/common';
import { SERVICE_CONFIG } from '../../config/config';
import type { ServiceConfig } from '../../config/config';
import { RagService } from '../../rag/rag.service';
import type { RetrievalStreamEvent, UserLocation } from '../../rag/rag.service';
import { GeocodingService } from '../location/geocoding.service';
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
 * Commands fall into three groups:
 *
 *   - Pure flags handled by the flow service (THINKING, DIRECT) — not
 *     fulfilled here.
 *   - Already-pre-injected values (LOCATION, DATE_TIME) — re-stated
 *     here for completeness when the LLM asks for them anyway, or
 *     fetched live if not yet known.
 *   - Real I/O commands (SEARCH) — calls RagService with the LLM's
 *     `search_prompt`.
 */
@Injectable()
export class CommandFulfillerService {
  private readonly log = new Logger(CommandFulfillerService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly rag: RagService,
    private readonly geocoding: GeocodingService,
  ) {}

  async fulfill(
    command: CommandKind,
    parsed: ParsedCommands,
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    switch (command) {
      case 'DATE_TIME':
        return { command, value: this.formatDateTime(ctx.occurredAt) };

      case 'LOCATION':
        return this.fulfillLocation(ctx, knownLocation);

      case 'SEARCH':
        return this.fulfillSearch(parsed.searchPrompt, ctx, knownLocation);

      case 'THINKING':
      case 'DIRECT':
        // Handled in the flow service as flags, not as fulfilled values.
        return { command, value: '' };
    }
  }

  private formatDateTime(occurredAt: string): string {
    const d = new Date(occurredAt);
    if (Number.isNaN(d.getTime())) return occurredAt;
    const date = d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const time = d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date}, ${time}`;
  }

  private async fulfillLocation(
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    if (knownLocation) {
      return { command: 'LOCATION', value: this.formatLocation(knownLocation) };
    }
    const raw = await ctx.resolveUserLocation();
    if (!raw) {
      return { command: 'LOCATION', value: 'unavailable' };
    }
    const enriched = await this.enrichLocation(raw);
    return {
      command: 'LOCATION',
      value: this.formatLocation(enriched),
      patch: { location: enriched },
    };
  }

  private formatLocation(loc: UserLocation): string {
    if (loc.cityName && loc.countryName) {
      return `${loc.cityName}, ${loc.countryName}`;
    }
    if (loc.cityName) return loc.cityName;
    return `lat ${loc.latitude}, lng ${loc.longitude}`;
  }

  private async enrichLocation(loc: UserLocation): Promise<UserLocation> {
    const geo = await this.geocoding.reverseGeocode({
      latitude: loc.latitude,
      longitude: loc.longitude,
    });
    if (!geo) return loc;
    return {
      ...loc,
      ...(geo.cityName ? { cityName: geo.cityName } : {}),
      ...(geo.regionName ? { regionName: geo.regionName } : {}),
      ...(geo.countryName ? { countryName: geo.countryName } : {}),
      ...(geo.countryCode ? { countryCode: geo.countryCode } : {}),
    };
  }

  private async fulfillSearch(
    searchPrompt: string | undefined,
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    const query = searchPrompt?.trim() || ctx.userText.trim();
    if (!searchPrompt) {
      this.log.warn(
        'SEARCH command emitted without a [search_prompt="..."] tag; falling back to userText.',
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
          command: 'SEARCH',
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
      return { command: 'SEARCH', value: lines.join('\n') };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`SEARCH fulfillment failed: ${message}`);
      return {
        command: 'SEARCH',
        value: `Search for "${query}" failed: ${message}`,
      };
    }
  }
}
