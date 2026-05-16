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
    // dateTime arrives as "17 May 2026, 02:01" (formatted by
    // reverse-control-flow.formatDateTime in the user's LOCAL
    // wall-clock time). Parsing it via Date.parse and serialising
    // back through toISOString reinterprets it as UTC and shifts
    // the date for any user east of UTC after the cutover — Romania
    // at 02:01 local is 23:01 UTC the day before, so the cache
    // bucketed "today" as yesterday and the briefing fetched stale
    // news. Pull the date from the formatted string directly.
    const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(dateTime.trim());
    if (m) {
      const day = m[1].padStart(2, '0');
      const monthName = m[2].toLowerCase();
      const months: Record<string, string> = {
        jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
        january: '01', february: '02', march: '03', april: '04', june: '06',
        july: '07', august: '08', september: '09', october: '10',
        november: '11', december: '12',
      };
      const month = months[monthName.slice(0, 3)] ?? months[monthName];
      if (month) return `${m[3]}-${month}-${day}`;
    }
    return dateTime.slice(0, 10);
  }

  private detectLanguageHint(text: string): string {
    // Diacritics first (highest-confidence signal).
    if (/[ăâîșțĂÂÎȘȚ]/.test(text)) return 'ro';
    if (/[àèéìòù]/.test(text)) return 'it';
    if (/[ñáéíóú¡¿]/.test(text)) return 'es';
    if (/[äöüß]/.test(text)) return 'de';
    // Fallback: function-word heuristic. Many users type without
    // diacritics (especially on mobile / English keyboards), so we
    // catch common stop-word patterns. Test for full-word matches
    // (word boundaries) to avoid false positives.
    const lower = text.toLowerCase();
    const has = (word: string): boolean =>
      new RegExp(`\\b${word}\\b`).test(lower);
    let roHits = 0, itHits = 0, esHits = 0, deHits = 0;
    for (const w of ['este', 'sunt', 'asta', 'acum', 'azi', 'aici', 'pentru', 'ce', 'cum', 'cand', 'când', 'unde', 'momentul', 'foarte']) {
      if (has(w)) roHits++;
    }
    for (const w of ['cosa', 'sono', 'questo', 'questa', 'adesso', 'oggi', 'qui', 'per', 'che', 'come', 'quando', 'dove', 'molto', 'allora']) {
      if (has(w)) itHits++;
    }
    for (const w of ['qué', 'que', 'son', 'esto', 'esta', 'ahora', 'hoy', 'aquí', 'para', 'cómo', 'cuándo', 'dónde', 'muy']) {
      if (has(w)) esHits++;
    }
    for (const w of ['ist', 'sind', 'das', 'jetzt', 'heute', 'hier', 'für', 'wie', 'wann', 'wo', 'sehr']) {
      if (has(w)) deHits++;
    }
    const best = Math.max(roHits, itHits, esHits, deHits);
    if (best >= 2) {
      if (roHits === best) return 'ro';
      if (itHits === best) return 'it';
      if (esHits === best) return 'es';
      if (deHits === best) return 'de';
    }
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
