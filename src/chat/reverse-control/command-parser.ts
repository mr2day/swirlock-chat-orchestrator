/**
 * Parses the LLM's reverse-control output (Nick's command format).
 *
 * Recognised forms:
 *   [command="DIRECT"]
 *   [command="SEARCH"][search_prompt="latest news Bucharest"]
 *   [command="SEARCH"][search_prompt="A"][search_prompt="B"][search_prompt="C"]
 *   [command="LOCATION, DATE_TIME, THINKING, SEARCH"][search_prompt="..."]
 *   [__meta_section__][command="..."][/__meta_section__]   (wrapping is optional)
 *
 * The parser is tolerant: it scans the entire response for `[command="..."]`
 * occurrences (multiple are allowed and unioned) and ALL `[search_prompt="..."]`
 * tags (when more than one is present, they become a parallel fan-out for the
 * SEARCH command). Names inside `command="..."` are split on commas and
 * case-folded to upper.
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
  /** Convenience: the first search prompt, kept for callers that
   *  still use single-query SEARCH (LOCATION / DATE_TIME). */
  searchPrompt?: string;
  /** All search prompts in order. Used by SEARCH for parallel fan-out
   *  across multiple query angles. */
  searchPrompts?: string[];
}

const COMMAND_RE = /\[command\s*=\s*"([^"]*)"/giu;
const SEARCH_PROMPT_RE = /\[search_prompt\s*=\s*"([^"]*)"/giu;

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
  const searchPrompts: string[] = [];
  SEARCH_PROMPT_RE.lastIndex = 0;
  let sp: RegExpExecArray | null;
  while ((sp = SEARCH_PROMPT_RE.exec(text)) !== null) {
    const value = sp[1].trim();
    if (value) searchPrompts.push(value);
  }
  if (searchPrompts.length === 0) {
    return { commands };
  }
  return {
    commands,
    searchPrompt: searchPrompts[0],
    searchPrompts,
  };
}
