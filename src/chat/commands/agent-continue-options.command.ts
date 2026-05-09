import { Injectable } from '@nestjs/common';
import type { AgentCommand, AgentCommandResult } from './agent-command.types';

@Injectable()
export class AgentContinueOptionsCommand implements AgentCommand {
  readonly name = 'agent.continue_with_options';

  startedSummary(): string {
    return 'Adjusting model options';
  }

  execute(
    _ctx: unknown,
    commandArgs: Record<string, unknown>,
  ): AgentCommandResult {
    const thinking = commandArgs.thinking === true;
    return {
      thinking,
      observation: {
        kind: this.name,
        summary: `The next agent step will use thinking=${thinking}.`,
        data: { thinking },
      },
    };
  }
}
