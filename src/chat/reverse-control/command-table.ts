/**
 * Reverse-control command table.
 *
 * Each entry describes one thing the LLM can ask the orchestrator
 * to fulfill. The LLM emits `[need="<kind>"]` (optionally with one
 * argument) and the orchestrator runs the matching handler in
 * `NeedFulfillerService`.
 *
 * The LLM signals "I have everything" by emitting `[done]`.
 *
 * Adding a capability = one row here + one branch in the fulfiller +
 * (optionally) extending the assessment prompt's example. Symmetric.
 */

export interface CommandEntry {
  /** The marker the LLM emits, e.g. `date`, `search`. */
  kind: string;
  /** Human description shown to the LLM in the assessment prompt. */
  describeForLlm: string;
  /** Optional arg name (only one for v1, e.g. `query` for `search`). */
  arg?: { name: string; describeForLlm: string };
}

export const COMMAND_TABLE: CommandEntry[] = [
  {
    kind: 'date',
    describeForLlm: 'today\'s date in human-readable form (e.g. "10 May 2026")',
  },
  {
    kind: 'time',
    describeForLlm: 'the user\'s current local time (e.g. "14:32")',
  },
  {
    kind: 'timezone',
    describeForLlm: 'the user\'s timezone identifier (e.g. "Europe/Bucharest")',
  },
  {
    kind: 'location',
    describeForLlm:
      "the user's city and country (will ask the user for location permission if not yet known)",
  },
  {
    kind: 'search',
    describeForLlm:
      'search the web / local knowledge for the given query and return the top results',
    arg: {
      name: 'query',
      describeForLlm: 'the exact search query string, written by you',
    },
  },
];

/**
 * Renders the command table as the LLM-visible block in the
 * assessment prompt.
 */
export function describeCommandTable(): string {
  const lines: string[] = ['Available needs:'];
  for (const entry of COMMAND_TABLE) {
    if (entry.arg) {
      lines.push(
        `- [need="${entry.kind}", ${entry.arg.name}="..."] — ${entry.describeForLlm}. The "${entry.arg.name}" argument is ${entry.arg.describeForLlm}.`,
      );
    } else {
      lines.push(`- [need="${entry.kind}"] — ${entry.describeForLlm}.`);
    }
  }
  lines.push(
    '- [done] — you have everything you need; the orchestrator will move on to composing the answer.',
  );
  return lines.join('\n');
}
