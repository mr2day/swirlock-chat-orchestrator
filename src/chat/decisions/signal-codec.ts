/**
 * Signal codec for the Decision Pipeline.
 *
 * Two forms, both delimited with mathematical white square brackets
 * `⟦` (U+27E6) and `⟧` (U+27E7):
 *
 * - **Atomic flag**: `⟦key=value⟧` — used for yes/no decisions and
 *   enum picks (`⟦action=search⟧`, `⟦location=needed⟧`).
 * - **Tagged payload**: `⟦key⟧free-form value⟦/key⟧` — used for
 *   arbitrary string values (`⟦query⟧vremea mâine în Bucharest⟦/query⟧`).
 *
 * The brackets are not used in any human writing system or common
 * programming language, so collisions with conversational text or
 * code samples are effectively zero. See `DECISION_PIPELINE.md`
 * for the full rationale.
 */

const FLAG_RE = /⟦([a-z_][a-z0-9_]*)=([a-z0-9_-]+)⟧/iu;
const PAYLOAD_RE = /⟦([a-z_][a-z0-9_]*)⟧([\s\S]*?)⟦\/\1⟧/iu;

export interface ParsedFlag {
  key: string;
  value: string;
}

export interface ParsedPayload {
  key: string;
  value: string;
}

/**
 * Returns the first atomic flag in the buffer, or `null` if none
 * matches. The match is case-insensitive on the key; the value is
 * returned as-typed.
 */
export function parseFlag(buffer: string): ParsedFlag | null {
  const m = buffer.match(FLAG_RE);
  if (!m) return null;
  return { key: m[1].toLowerCase(), value: m[2] };
}

/**
 * Returns the first tagged-payload pair in the buffer, or `null` if
 * none matches. The match is case-insensitive on the key; the value
 * is returned with whitespace preserved (caller may trim).
 */
export function parsePayload(buffer: string): ParsedPayload | null {
  const m = buffer.match(PAYLOAD_RE);
  if (!m) return null;
  return { key: m[1].toLowerCase(), value: m[2] };
}
