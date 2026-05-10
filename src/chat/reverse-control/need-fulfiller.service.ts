import { Inject, Injectable, Logger } from '@nestjs/common';
import { SERVICE_CONFIG } from '../../config/config';
import type { ServiceConfig } from '../../config/config';
import { RagService } from '../../rag/rag.service';
import type { RetrievalStreamEvent, UserLocation } from '../../rag/rag.service';
import { GeocodingService } from '../location/geocoding.service';
import type { ParsedNeed } from './need-parser';

export interface FulfillContext {
  correlationId: string;
  sessionId: string;
  userText: string;
  occurredAt: string;
  abortSignal: AbortSignal;
  /** The location attached at turn.submit time, already enriched. */
  initialLocation: UserLocation | undefined;
  /**
   * Asks the chat client for live geolocation (turn.location_required
   * → turn.location_response). Null if user denies / times out.
   */
  resolveUserLocation: () => Promise<UserLocation | null>;
  onRetrievalStreamEvent: (event: RetrievalStreamEvent) => void;
}

export interface FulfillmentResult {
  /** The need that was fulfilled (kind + optional arg). */
  need: ParsedNeed;
  /** Short value the orchestrator injects back into the next prompt. */
  value: string;
  /**
   * Side-effects this fulfillment leaves on the turn context, if any.
   * E.g., resolving location updates the turn's known location so a
   * subsequent `need="search"` can include the city in the query
   * automatically (the LLM still controls the query, but the
   * fulfilled location is visible to it).
   */
  patch?: { location?: UserLocation };
}

/**
 * Dispatches a parsed need to its handler.
 *
 * Handlers are deliberately small: pull from already-known turn
 * context (date, location), or call out to RAG / Geocoding for the
 * data the orchestrator does have to fetch. Each handler returns a
 * short string the assessment loop will inject back into the next
 * prompt as fulfilled context.
 */
@Injectable()
export class NeedFulfillerService {
  private readonly log = new Logger(NeedFulfillerService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly rag: RagService,
    private readonly geocoding: GeocodingService,
  ) {}

  async fulfill(
    need: ParsedNeed,
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    switch (need.kind) {
      case 'date':
        return { need, value: this.formatDate(ctx.occurredAt) };

      case 'time':
        return { need, value: this.formatTime(ctx.occurredAt) };

      case 'timezone':
        return { need, value: this.formatTimezone() };

      case 'location':
        return this.fulfillLocation(ctx, knownLocation);

      case 'search':
        return this.fulfillSearch(need, ctx, knownLocation);

      default:
        return {
          need,
          value: `(unknown need "${need.kind}" — orchestrator has no handler for this)`,
        };
    }
  }

  private formatDate(occurredAt: string): string {
    const d = new Date(occurredAt);
    if (Number.isNaN(d.getTime())) return occurredAt;
    return d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  private formatTime(occurredAt: string): string {
    const d = new Date(occurredAt);
    if (Number.isNaN(d.getTime())) return occurredAt;
    return d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private formatTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async fulfillLocation(
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    if (knownLocation) {
      return {
        need: { kind: 'location' },
        value: this.formatLocation(knownLocation),
      };
    }
    const raw = await ctx.resolveUserLocation();
    if (!raw) {
      return { need: { kind: 'location' }, value: 'unavailable' };
    }
    const enriched = await this.enrichLocation(raw);
    return {
      need: { kind: 'location' },
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
    need: ParsedNeed,
    ctx: FulfillContext,
    knownLocation: UserLocation | undefined,
  ): Promise<FulfillmentResult> {
    const query = need.arg?.value?.trim();
    if (!query) {
      return {
        need,
        value: '(search needed but no "query" argument was provided)',
      };
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
          need,
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
      return { need, value: lines.join('\n') };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`search fulfillment failed: ${message}`);
      return {
        need,
        value: `Search for "${query}" failed: ${message}`,
      };
    }
  }
}
