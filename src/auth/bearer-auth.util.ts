import type { IncomingMessage } from 'http';

/**
 * Extracts a bearer token from an HTTP/WebSocket-upgrade request.
 *
 * Supports three transports, in order:
 *  1. `Authorization: Bearer <token>` — standard, used by all non-browser clients.
 *  2. `?token=<token>` query parameter — for browsers, since
 *     `new WebSocket(url)` cannot set custom headers.
 *  3. `Sec-WebSocket-Protocol: bearer, <token>` — also browser-friendly via
 *     `new WebSocket(url, ['bearer', '<token>'])`.
 *
 * Returns `undefined` when no token is found.
 */
export function extractBearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t.length > 0) return t;
  }

  if (req.url) {
    const qIdx = req.url.indexOf('?');
    if (qIdx >= 0) {
      const params = new URLSearchParams(req.url.slice(qIdx + 1));
      const t = params.get('token');
      if (t && t.length > 0) return t;
    }
  }

  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    const parts = proto
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const idx = parts.indexOf('bearer');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  }

  return undefined;
}
