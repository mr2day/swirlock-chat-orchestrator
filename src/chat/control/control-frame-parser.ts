import type { AgentFrame } from '../commands/agent-command.types';
import { isRecord, stringArg } from '../commands/command-utils';

/**
 * Parses the control-step LLM output into an `AgentFrame`. The model
 * is instructed to emit JSON only, but in practice it occasionally
 * wraps the JSON in prose, so we fall back to extracting the first
 * `{...}` block before giving up. A non-JSON output is treated as a
 * `mode: final` signal.
 */
export function parseAgentFrame(rawText: string): AgentFrame {
  const parsed = parseJsonObject(rawText);
  if (!parsed) {
    return {
      mode: 'final',
      reason: 'Model returned non-JSON text; treated as final answer.',
    };
  }

  const mode = parsed.mode === 'command' ? 'command' : 'final';
  if (mode === 'final') {
    return {
      mode,
      reason: stringArg(parsed.reason),
    };
  }

  return {
    mode,
    command: stringArg(parsed.command),
    arguments: isRecord(parsed.arguments) ? parsed.arguments : {},
    reason: stringArg(parsed.reason),
  };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
