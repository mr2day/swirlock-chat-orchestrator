/**
 * Parses the LLM's reverse-control output.
 *
 * Recognised forms:
 *   [done]                                          — terminator
 *   [need="date"]                                    — atomic need
 *   [need="date", need="time"]                       — chained
 *   [need="search", query="vremea în Bucureşti"]    — need with one arg
 *   [need="date"][need="search", query="..."]       — multiple bracket pairs
 *
 * The parser is deliberately tolerant: it scans the entire response
 * for `need="..."` occurrences regardless of how the LLM bracketed
 * them. Args are detected when they immediately follow a `need="..."`
 * with the form `, NAME="VALUE"` (and NAME is not `need`).
 */

export interface ParsedNeed {
  kind: string;
  arg?: { name: string; value: string };
}

export interface ParsedReverseControl {
  done: boolean;
  needs: ParsedNeed[];
}

const NEED_RE =
  /need="([a-z_][a-z0-9_]*)"(?:\s*,\s*(?!need=)([a-z_][a-z0-9_]*)="([^"]*)")?/giu;
const DONE_RE = /\[done\]/iu;

export function parseReverseControl(text: string): ParsedReverseControl {
  const needs: ParsedNeed[] = [];
  let m: RegExpExecArray | null;
  NEED_RE.lastIndex = 0;
  while ((m = NEED_RE.exec(text)) !== null) {
    const need: ParsedNeed = { kind: m[1].toLowerCase() };
    if (m[2] && m[3] !== undefined) {
      need.arg = { name: m[2].toLowerCase(), value: m[3] };
    }
    needs.push(need);
  }
  const done = DONE_RE.test(text) && needs.length === 0;
  return { done, needs };
}
