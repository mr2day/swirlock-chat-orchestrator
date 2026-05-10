/**
 * Parses the LLM's reverse-control output (Nick's command format).
 *
 * Recognised forms:
 *   [command="DIRECT"]
 *   [command="SEARCH"][search_prompt="latest news Bucharest"]
 *   [command="LOCATION, DATE_TIME, THINKING, SEARCH"][search_prompt="..."]
 *   [__meta_section__][command="..."][/__meta_section__]   (wrapping is optional)
 *
 * The parser is tolerant: it scans the entire response for `[command="..."]`
 * occurrences (multiple are allowed and unioned) and one optional
 * `[search_prompt="..."]` tag. Names inside `command="..."` are split on
 * commas and case-folded to upper.
 */

export type CommandKind =
  | 'LOCATION'
  | 'DATE_TIME'
  | 'THINKING'
  | 'SEARCH'
  | 'DIRECT';

const KNOWN_COMMANDS: ReadonlySet<CommandKind> = new Set([
  'LOCATION',
  'DATE_TIME',
  'THINKING',
  'SEARCH',
  'DIRECT',
]);

export interface ParsedCommands {
  commands: Set<CommandKind>;
  searchPrompt?: string;
}

// Tolerant: match `[command="..."` regardless of what follows (so both
// `[command="SEARCH"]` and `[command="LOCATION", search_prompt="..."]`
// — inline-attribute form — are picked up). `[search_prompt="..."]`
// is matched the same way.
const COMMAND_RE = /\[command\s*=\s*"([^"]*)"/giu;
const SEARCH_PROMPT_RE = /\[search_prompt\s*=\s*"([^"]*)"/iu;

export function parseCommands(text: string): ParsedCommands {
  const commands = new Set<CommandKind>();
  let m: RegExpExecArray | null;
  COMMAND_RE.lastIndex = 0;
  while ((m = COMMAND_RE.exec(text)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().toUpperCase();
      if ((KNOWN_COMMANDS as ReadonlySet<string>).has(name)) {
        commands.add(name as CommandKind);
      }
    }
  }
  const sp = SEARCH_PROMPT_RE.exec(text);
  const searchPrompt = sp && sp[1].trim() ? sp[1].trim() : undefined;
  return searchPrompt ? { commands, searchPrompt } : { commands };
}
