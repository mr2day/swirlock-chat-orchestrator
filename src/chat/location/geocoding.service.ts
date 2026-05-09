import { Injectable, Logger } from '@nestjs/common';

export interface ReverseGeocodeResult {
  cityName: string | null;
  regionName: string | null;
  countryName: string | null;
  countryCode: string | null;
}

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  region?: string;
  country?: string;
  country_code?: string;
}

interface NominatimResponse {
  address?: NominatimAddress;
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const TIMEOUT_MS = 3000;
const USER_AGENT =
  'swirlock-chat-orchestrator/0.0.1 (https://github.com/mr2day/swirlock-chat-orchestrator)';

/**
 * Server-side reverse geocoding for user-provided coordinates.
 *
 * The browser delivers raw lat/long from the Geolocation API; the
 * Vanamonde model is too small to translate those coordinates into a
 * city name reliably. This service does the deterministic part once
 * (Nominatim, cached) so the prompt builders can render
 * "User location available: city Bucharest, country Romania, lat …,
 * lng …" and the agent can include the city in its rag.retrieve
 * queries.
 *
 * Privacy note: coordinates are sent to a third-party (OpenStreetMap
 * Nominatim). Switch to a self-hosted reverse-geocoder before
 * production deployment if that's a concern.
 *
 * Rate-limit note: Nominatim's public usage policy is 1 req/s. The
 * cache here is keyed at ~3-decimal precision (~110m), which is
 * plenty for city-level resolution and dramatically reduces upstream
 * traffic for users in the same area.
 */
@Injectable()
export class GeocodingService {
  private readonly log = new Logger(GeocodingService.name);
  private readonly cache = new Map<string, ReverseGeocodeResult | null>();

  async reverseGeocode(args: {
    latitude: number;
    longitude: number;
  }): Promise<ReverseGeocodeResult | null> {
    const key = `${args.latitude.toFixed(3)},${args.longitude.toFixed(3)}`;
    if (this.cache.has(key)) {
      return this.cache.get(key) ?? null;
    }

    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(args.latitude));
    url.searchParams.set('lon', String(args.longitude));
    url.searchParams.set('zoom', '10');
    url.searchParams.set('accept-language', 'en');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) {
        this.log.warn(
          `Nominatim returned HTTP ${res.status} for (${args.latitude}, ${args.longitude})`,
        );
        this.cache.set(key, null);
        return null;
      }
      const data = (await res.json()) as NominatimResponse;
      const addr = data.address ?? {};
      const result: ReverseGeocodeResult = {
        cityName:
          addr.city ??
          addr.town ??
          addr.village ??
          addr.municipality ??
          addr.county ??
          null,
        regionName: addr.state ?? addr.region ?? null,
        countryName: addr.country ?? null,
        countryCode: addr.country_code ? addr.country_code.toUpperCase() : null,
      };
      this.cache.set(key, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `Reverse geocode failed for (${args.latitude}, ${args.longitude}): ${message}`,
      );
      this.cache.set(key, null);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
