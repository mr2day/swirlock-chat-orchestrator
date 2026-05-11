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
  /**
   * One-sentence directive in the user's language telling the model to
   * reply in that language. Emitted by the assessment-round LLM as
   * `[language_directive="..."]`. The orchestrator passes it through to
   * the answer round and prepends it to the system message. Using the
   * LLM as the language oracle (instead of a hardcoded list) means
   * Polish, Japanese, Hungarian — anything — work without code changes.
   */
  languageDirective?: string;
}

const COMMAND_RE = /\[command\s*=\s*"([^"]*)"/giu;
const SEARCH_PROMPT_RE = /\[search_prompt\s*=\s*"([^"]*)"/iu;
const LANGUAGE_DIRECTIVE_RE = /\[language_directive\s*=\s*"([^"]*)"/iu;

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
  const ld = LANGUAGE_DIRECTIVE_RE.exec(text);
  const out: ParsedCommands = { commands };
  if (sp && sp[1].trim()) out.searchPrompt = sp[1].trim();
  if (ld && ld[1].trim()) out.languageDirective = ld[1].trim();
  return out;
}
