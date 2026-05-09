import { Injectable } from '@nestjs/common';
import { DecisionTraceService } from '../trace/decision-trace.service';
import type {
  AgentCommand,
  AgentCommandContext,
  AgentCommandResult,
} from './agent-command.types';
import { isRecord, stringArg } from './command-utils';

@Injectable()
export class PlanCreateCommand implements AgentCommand {
  readonly name = 'plan.create';

  constructor(private readonly trace: DecisionTraceService) {}

  startedSummary(): string {
    return 'Creating a plan';
  }

  execute(
    ctx: AgentCommandContext,
    commandArgs: Record<string, unknown>,
  ): AgentCommandResult {
    const title = stringArg(commandArgs.title) || 'Agent plan';
    const stepsRaw = Array.isArray(commandArgs.steps) ? commandArgs.steps : [];
    const steps = stepsRaw
      .filter((step): step is Record<string, unknown> => isRecord(step))
      .map((step) => ({
        title: stringArg(step.title) || 'Untitled step',
        ...(stringArg(step.details)
          ? { details: stringArg(step.details)! }
          : {}),
      }))
      .slice(0, 12);
    if (steps.length === 0) {
      throw new Error('plan.create requires at least one step.');
    }

    const plan = this.trace.createPlan({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      correlationId: ctx.correlationId,
      title,
      steps,
    });

    ctx.onAgentActivity?.({
      command: this.name,
      phase: 'plan',
      summary: `Plan: ${plan.title} (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}).`,
      data: { planId: plan.planId, stepCount: plan.steps.length },
    });

    return {
      observation: {
        kind: this.name,
        summary: `Created plan "${plan.title}" with ${plan.steps.length} step(s).`,
        data: plan,
      },
    };
  }
}
