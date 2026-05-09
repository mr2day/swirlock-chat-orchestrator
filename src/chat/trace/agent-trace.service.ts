import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';

export type AgentPlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export interface AgentPlanStepInput {
  title: string;
  details?: string;
}

export interface AgentPlanSnapshot {
  planId: string;
  title: string;
  status: string;
  steps: Array<{
    stepId: string;
    stepIndex: number;
    title: string;
    details?: string;
    status: string;
    note?: string;
  }>;
}

interface AgentEventRow {
  event_type: string;
  command: string | null;
  summary: string;
  created_at: string;
}

interface AgentPlanRow {
  id: string;
  title: string;
  status: string;
}

interface AgentPlanStepRow {
  id: string;
  step_index: number;
  title: string;
  details: string | null;
  status: string;
  note: string | null;
}

@Injectable()
export class AgentTraceService {
  constructor(private readonly db: DatabaseService) {}

  recordEvent(args: {
    sessionId: string;
    turnId: string;
    correlationId: string;
    eventType: string;
    summary: string;
    command?: string;
    payload?: unknown;
  }): void {
    const now = new Date().toISOString();
    const seq = this.nextEventSeq(args.sessionId);
    this.db.connection
      .prepare(
        `INSERT INTO agent_events
           (id, session_id, turn_id, correlation_id, event_type, command, summary, payload_json, created_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        args.sessionId,
        args.turnId,
        args.correlationId,
        args.eventType,
        args.command ?? null,
        args.summary,
        args.payload === undefined ? null : JSON.stringify(args.payload),
        now,
        seq,
      );
  }

  /**
   * Builds an objective, language-agnostic summary of what happened in a
   * specific prior assistant turn, derived from `agent_events` for that
   * turn_id. Used by the agent control step to substitute into history
   * in place of the raw assistant prose, so the control LLM's tool-use
   * decision is grounded in the *actions* taken last time, not in the
   * subjective claims the assistant model wrote ("I couldn't find...",
   * "maybe you mean..."). The final-answer step still receives the
   * original prose verbatim.
   *
   * Returns a short bracketed marker like
   * `[prior-turn: rag.retrieve("Grindeanu...")=>6 evidence; final answer delivered]`,
   * or `[prior-turn: final answer delivered]` if no commands ran, or
   * `[prior-turn: no orchestrator trace available]` for legacy turns
   * predating the agent_events table.
   */
  summarizePriorAssistantTurn(sessionId: string, turnId: string): string {
    const rows = this.db.connection
      .prepare(
        `SELECT event_type, command, summary, payload_json
           FROM agent_events
          WHERE session_id = ? AND turn_id = ?
          ORDER BY seq ASC`,
      )
      .all(sessionId, turnId) as Array<{
      event_type: string;
      command: string | null;
      summary: string;
      payload_json: string | null;
    }>;

    if (rows.length === 0) {
      return '[prior-turn: no orchestrator trace available]';
    }

    const actionParts: string[] = [];
    let producedFinalAnswer = false;
    let aborted = false;

    for (const row of rows) {
      if (row.event_type === 'agent.command.completed' && row.command) {
        actionParts.push(this.formatCompletedCommand(row));
        continue;
      }
      if (row.event_type === 'agent.command.failed' && row.command) {
        actionParts.push(`${row.command}=>failed`);
        continue;
      }
      if (row.event_type === 'agent.command.skipped' && row.command) {
        actionParts.push(`${row.command}=>skipped(duplicate)`);
        continue;
      }
      if (row.event_type === 'agent.final.completed') {
        producedFinalAnswer = true;
      }
      if (row.event_type === 'agent.loop.aborted') {
        aborted = true;
      }
    }

    const segments: string[] = [];
    if (actionParts.length > 0) {
      segments.push(`actions: ${actionParts.join('; ')}`);
    }
    if (producedFinalAnswer) {
      segments.push('final answer delivered');
    }
    if (aborted) {
      segments.push('turn aborted');
    }
    if (segments.length === 0) {
      segments.push('no recorded actions');
    }
    return `[prior-turn: ${segments.join('; ')}]`;
  }

  private formatCompletedCommand(row: {
    command: string | null;
    payload_json: string | null;
  }): string {
    const command = row.command ?? '?';
    const payload = this.safeParseJson(row.payload_json);
    if (command === 'rag.retrieve') {
      const query =
        typeof payload?.query === 'string'
          ? this.truncateText(payload.query, 80)
          : null;
      const evidenceCount =
        typeof payload?.evidenceCount === 'number'
          ? payload.evidenceCount
          : null;
      const queryPart = query ? `query="${query}"` : '';
      const evidencePart =
        evidenceCount !== null ? `=>${evidenceCount} evidence` : '';
      return `rag.retrieve(${queryPart})${evidencePart}`;
    }
    if (command === 'plan.create') {
      const stepCount =
        typeof payload?.steps === 'object' &&
        Array.isArray((payload as { steps?: unknown[] }).steps)
          ? (payload as { steps: unknown[] }).steps.length
          : null;
      return `plan.create(${stepCount ?? '?'} steps)`;
    }
    if (command === 'plan.update') {
      return 'plan.update';
    }
    if (command === 'location.request') {
      return 'location.request';
    }
    return command;
  }

  private safeParseJson(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private truncateText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  recentActivitySummary(sessionId: string, limit = 12): string | null {
    const rows = this.db.connection
      .prepare(
        `SELECT event_type, command, summary, created_at
           FROM agent_events
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(sessionId, limit) as AgentEventRow[];

    if (rows.length === 0) return null;

    return rows
      .reverse()
      .map((row) => {
        const command = row.command ? `/${row.command}` : '';
        return `- ${row.created_at} [${row.event_type}${command}] ${row.summary}`;
      })
      .join('\n');
  }

  createPlan(args: {
    sessionId: string;
    turnId: string;
    correlationId: string;
    title: string;
    steps: AgentPlanStepInput[];
  }): AgentPlanSnapshot {
    const now = new Date().toISOString();
    const planId = randomUUID();
    const steps = args.steps.slice(0, 12);

    const tx = this.db.connection.transaction(() => {
      this.db.connection
        .prepare(
          `INSERT INTO agent_plans
             (id, session_id, turn_id, correlation_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          planId,
          args.sessionId,
          args.turnId,
          args.correlationId,
          this.limitText(args.title, 240),
          now,
          now,
        );

      steps.forEach((step, index) => {
        this.db.connection
          .prepare(
            `INSERT INTO agent_plan_steps
               (id, plan_id, step_index, title, details, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            randomUUID(),
            planId,
            index + 1,
            this.limitText(step.title, 240),
            step.details ? this.limitText(step.details, 800) : null,
            now,
            now,
          );
      });
    });
    tx();

    return this.planSnapshot(planId)!;
  }

  updatePlanStep(args: {
    sessionId: string;
    planId?: string;
    stepId?: string;
    stepIndex?: number;
    status: AgentPlanStepStatus;
    note?: string;
  }): AgentPlanSnapshot {
    const planId = args.planId ?? this.latestActivePlanId(args.sessionId);
    if (!planId) {
      throw new Error('No active agent plan exists for this session.');
    }

    const now = new Date().toISOString();
    const note = args.note ? this.limitText(args.note, 800) : null;

    const updateById = args.stepId
      ? this.db.connection
          .prepare(
            `UPDATE agent_plan_steps
                SET status = ?, note = ?, updated_at = ?
              WHERE id = ? AND plan_id = ?`,
          )
          .run(args.status, note, now, args.stepId, planId)
      : null;

    const updateByIndex =
      !args.stepId && typeof args.stepIndex === 'number'
        ? this.db.connection
            .prepare(
              `UPDATE agent_plan_steps
                  SET status = ?, note = ?, updated_at = ?
                WHERE plan_id = ? AND step_index = ?`,
            )
            .run(args.status, note, now, planId, args.stepIndex)
        : null;

    const changed = Number(updateById?.changes ?? updateByIndex?.changes ?? 0);
    if (changed === 0) {
      throw new Error('Agent plan step not found.');
    }

    this.db.connection
      .prepare(`UPDATE agent_plans SET updated_at = ? WHERE id = ?`)
      .run(now, planId);
    this.completePlanIfFinished(planId, now);

    return this.planSnapshot(planId)!;
  }

  activePlanSummary(sessionId: string): string | null {
    const planId = this.latestActivePlanId(sessionId);
    if (!planId) return null;
    const snapshot = this.planSnapshot(planId);
    if (!snapshot) return null;

    const lines = [`Active plan: ${snapshot.title} (${snapshot.status})`];
    for (const step of snapshot.steps) {
      lines.push(
        `- ${step.stepIndex}. [${step.status}] ${step.title}${step.note ? ` - ${step.note}` : ''}`,
      );
    }
    return lines.join('\n');
  }

  private nextEventSeq(sessionId: string): number {
    const row = this.db.connection
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS maxSeq
           FROM agent_events
          WHERE session_id = ?`,
      )
      .get(sessionId) as { maxSeq: number };
    return row.maxSeq + 1;
  }

  private latestActivePlanId(sessionId: string): string | null {
    const row = this.db.connection
      .prepare(
        `SELECT id
           FROM agent_plans
          WHERE session_id = ? AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(sessionId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private planSnapshot(planId: string): AgentPlanSnapshot | null {
    const plan = this.db.connection
      .prepare(`SELECT id, title, status FROM agent_plans WHERE id = ?`)
      .get(planId) as AgentPlanRow | undefined;
    if (!plan) return null;

    const steps = this.db.connection
      .prepare(
        `SELECT id, step_index, title, details, status, note
           FROM agent_plan_steps
          WHERE plan_id = ?
          ORDER BY step_index ASC`,
      )
      .all(planId) as AgentPlanStepRow[];

    return {
      planId: plan.id,
      title: plan.title,
      status: plan.status,
      steps: steps.map((step) => ({
        stepId: step.id,
        stepIndex: step.step_index,
        title: step.title,
        ...(step.details ? { details: step.details } : {}),
        status: step.status,
        ...(step.note ? { note: step.note } : {}),
      })),
    };
  }

  private completePlanIfFinished(planId: string, now: string): void {
    const row = this.db.connection
      .prepare(
        `SELECT
            SUM(CASE WHEN status IN ('completed', 'cancelled') THEN 1 ELSE 0 END) AS terminalCount,
            COUNT(*) AS totalCount
           FROM agent_plan_steps
          WHERE plan_id = ?`,
      )
      .get(planId) as { terminalCount: number; totalCount: number };

    if (row.totalCount > 0 && row.terminalCount === row.totalCount) {
      this.db.connection
        .prepare(
          `UPDATE agent_plans
              SET status = 'completed', updated_at = ?
            WHERE id = ? AND status = 'active'`,
        )
        .run(now, planId);
    }
  }

  private limitText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }
}
