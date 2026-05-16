import { Injectable, Logger } from '@nestjs/common';
import { RagService } from '../rag/rag.service';

interface CacheEntry {
  text: string;
  fetchedAt: number;
}

/**
 * Fetches a "what's notable today" digest the classifier can use to
 * bias its search queries toward genuinely-airing events. Without it
 * the classifier writes generic schedule-style queries and Exa's top
 * hits are all listing pages — Eurovision-class live events get
 * buried under the daily-EPG noise even though the answer was a few
 * search results away.
 *
 * Cached by (date, language-hint) for 1 hour. First request of the
 * hour pays ~2s of latency; subsequent requests of the same hour hit
 * the cache instantly.
 */
@Injectable()
export class DailyBriefingService {
  private readonly log = new Logger(DailyBriefingService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly TTL_MS = 60 * 60 * 1000;

  constructor(private readonly rag: RagService) {}

  async getBriefing(args: {
    sessionId: string;
    correlationId: string;
    userText: string;
    dateTime: string;
  }): Promise<string | null> {
    const dateKey = this.dateKey(args.dateTime);
    const langKey = this.detectLanguageHint(args.userText);
    const cacheKey = `${dateKey}::${langKey}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < this.TTL_MS) {
      return cached.text;
    }

    const query = this.buildQuery(dateKey, langKey);

    try {
      const result = await this.rag.retrieve({
        correlationId: `${args.correlationId}:briefing`,
        sessionId: args.sessionId,
        userText: args.userText,
        parts: [{ type: 'text', text: query }],
        resolvedQueryText: query,
        freshness: 'realtime',
        allowedModes: ['live_web'],
      });

      if (result.evidence.length === 0) {
        return null;
      }

      const lines = result.evidence.slice(0, 5).map((ev) => {
        const snippet = ev.snippet?.replace(/\s+/g, ' ').trim() ?? '';
        const short = snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
        return short ? `- ${ev.sourceTitle}: ${short}` : `- ${ev.sourceTitle}`;
      });

      const text = lines.join('\n');
      this.cache.set(cacheKey, { text, fetchedAt: Date.now() });
      this.log.log(
        `[briefing] cached digest for ${cacheKey} (${result.evidence.length} sources, ${text.length} chars).`,
      );
      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`[briefing] fetch failed (${cacheKey}): ${message}`);
      return null;
    }
  }

  private dateKey(dateTime: string): string {
    // Best-effort YYYY-MM-DD; if dateTime is human-readable like
    // "17 May 2026, 01:45" we fall back to splitting on common
    // separators. Cache key correctness matters more than format
    // precision here.
    const parsed = Date.parse(dateTime);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    return dateTime.slice(0, 16);
  }

  private detectLanguageHint(text: string): string {
    if (/[ăâîșțĂÂÎȘȚ]/.test(text)) return 'ro';
    if (/[àèéìòù]/.test(text)) return 'it';
    if (/[ñáéíóú¡¿]/.test(text)) return 'es';
    if (/[äöüß]/.test(text)) return 'de';
    return 'en';
  }

  private buildQuery(dateKey: string, langKey: string): string {
    const human = dateKey;
    switch (langKey) {
      case 'ro':
        return `principalele evenimente, transmisiuni live și știri din ${human}`;
      case 'it':
        return `principali eventi, dirette TV e notizie del ${human}`;
      case 'es':
        return `principales eventos, transmisiones en vivo y noticias del ${human}`;
      case 'de':
        return `wichtige Ereignisse, Live-Übertragungen und Nachrichten vom ${human}`;
      default:
        return `major events, live broadcasts, and breaking news today ${human}`;
    }
  }
}
