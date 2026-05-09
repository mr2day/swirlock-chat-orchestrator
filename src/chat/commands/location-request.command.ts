import { Injectable } from '@nestjs/common';
import type {
  AgentCommand,
  AgentCommandContext,
  AgentCommandResult,
} from './agent-command.types';

@Injectable()
export class LocationRequestCommand implements AgentCommand {
  readonly name = 'location.request';

  startedSummary(): string {
    return 'Asking for your location';
  }

  async execute(ctx: AgentCommandContext): Promise<AgentCommandResult> {
    const location = ctx.resolveUserLocation
      ? await ctx.resolveUserLocation()
      : null;
    const summary = location
      ? `User granted location: latitude ${location.latitude}, longitude ${location.longitude}.`
      : 'User location was not available for this turn.';

    return {
      ...(location ? { userLocation: location } : {}),
      observation: {
        kind: this.name,
        summary,
        data: location ?? { available: false },
      },
    };
  }
}
