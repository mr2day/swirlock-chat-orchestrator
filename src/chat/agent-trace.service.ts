import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';

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
