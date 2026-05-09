import { Injectable } from '@nestjs/common';
import { AgentTraceService } from '../trace/agent-trace.service';
import type { AgentPlanStepStatus } from '../trace/agent-trace.service';
import type {
  AgentCommand,
  AgentCommandContext,
  AgentCommandResult,
} from './agent-command.types';
import { enumArg, stringArg } from './command-utils';

const PLAN_STATUSES: AgentPlanStepStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'cancelled',
];

@Injectable()
export class PlanUpdateCommand implements AgentCommand {
  readonly name = 'plan.update';

  constructor(private readonly trace: AgentTraceService) {}

  startedSummary(): string {
    return 'Updating the plan';
  }

  execute(
    ctx: AgentCommandContext,
    commandArgs: Record<string, unknown>,
  ): AgentCommandResult {
    const status = enumArg(commandArgs.status, PLAN_STATUSES, 'in_progress');
    const plan = this.trace.updatePlanStep({
      sessionId: ctx.sessionId,
      ...(stringArg(commandArgs.planId)
        ? { planId: stringArg(commandArgs.planId)! }
        : {}),
      ...(stringArg(commandArgs.stepId)
        ? { stepId: stringArg(commandArgs.stepId)! }
        : {}),
      ...(typeof commandArgs.stepIndex === 'number'
        ? { stepIndex: commandArgs.stepIndex }
        : {}),
      status,
      ...(stringArg(commandArgs.note)
        ? { note: stringArg(commandArgs.note)! }
        : {}),
    });

    const totalSteps = plan.steps.length;
    const completedSteps = plan.steps.filter(
      (planStep) =>
        planStep.status === 'completed' || planStep.status === 'cancelled',
    ).length;
    ctx.onAgentActivity?.({
      command: this.name,
      phase: 'plan',
      summary: `Plan progress: ${completedSteps}/${totalSteps} step${totalSteps === 1 ? '' : 's'} done.`,
      data: { planId: plan.planId, completedSteps, totalSteps },
    });

    return {
      observation: {
        kind: this.name,
        summary: `Updated plan "${plan.title}".`,
        data: plan,
      },
    };
  }
}
