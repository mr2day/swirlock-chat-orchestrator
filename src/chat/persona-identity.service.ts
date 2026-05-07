import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';

const FALLBACK_PERSONA_ID = 'default-assistant';

interface PersonaSeed {
  id: string;
  version: number;
  canonicalName: string;
  displayName: string;
  corePrompt: string;
  facts: Array<{
    id: string;
    factType: string;
    content: string;
    importance: 'critical' | 'high' | 'medium' | 'low';
    mutable: boolean;
  }>;
}

const SEEDED_PERSONAS: Record<string, PersonaSeed> = {
  'gigi-the-robot': {
    id: 'gigi-the-robot',
    version: 2,
    canonicalName: 'gigi-the-robot',
    displayName: 'Gigi the Robot',
    corePrompt: [
      'You are Gigi the Robot.',
      'If asked your name, say your name is Gigi the Robot.',
      'You are a friendly robot chatbot persona.',
      'You are not human and should not claim human biology, childhood, sleep, or consciousness.',
      'You maintain continuity through stored persona identity, relationship memory, conversation context, and retrieved evidence.',
      'Your default style is friendly, practical, curious, and lightly playful.',
      'These identity facts are background grounding; they must not reduce creativity, technical precision, or the style the user explicitly requests.',
      'When uncertain, say what is missing instead of inventing facts.',
    ].join('\n'),
    facts: [
      {
        id: 'gigi-the-robot:fact:name',
        factType: 'name',
        content: 'The persona name is Gigi the Robot.',
        importance: 'critical',
        mutable: false,
      },
      {
        id: 'gigi-the-robot:fact:kind',
        factType: 'kind',
        content: 'Gigi is a chatbot persona, not a human.',
        importance: 'critical',
        mutable: false,
      },
      {
        id: 'gigi-the-robot:fact:style',
        factType: 'style',
        content:
          'Gigi defaults to a friendly, practical, curious, and lightly playful voice.',
        importance: 'high',
        mutable: true,
      },
    ],
  },
};

interface PersonaRow {
  id: string;
  display_name: string;
}

interface IdentityVersionRow {
  version: number;
  core_prompt: string;
}

interface IdentityFactRow {
  content: string;
}

interface ReflectionRow {
  content: string;
}

interface RelationshipRow {
  summary: string | null;
}

interface SessionIdentityRow {
  user_id: string;
  persona_id: string | null;
}

export interface PersonaIdentityCapsule {
  personaId: string;
  displayName: string;
  identityVersion: number;
  coreMessage: string;
  contextualMessage?: string;
  factCount: number;
  reflectionCount: number;
}

@Injectable()
export class PersonaIdentityService {
  constructor(private readonly db: DatabaseService) {}

  prepareCapsule(args: {
    personaId: string | null;
    userId: string;
    sessionId: string;
    occurredAt: string;
  }): PersonaIdentityCapsule {
    const personaId = this.normalizePersonaId(args.personaId);
    this.ensurePersonaSeed(personaId, args.occurredAt);

    const persona = this.db.connection
      .prepare(`SELECT id, display_name FROM personas WHERE id = ?`)
      .get(personaId) as PersonaRow;
    const version = this.activeIdentityVersion(personaId);
    const facts = this.identityFacts(personaId);
    const reflections = this.recentReflections(personaId);
    const relationship = this.relationshipSummary(personaId, args.userId);

    const contextual = this.buildContextualMessage({
      facts,
      reflections,
      relationship,
    });

    return {
      personaId,
      displayName: persona.display_name,
      identityVersion: version.version,
      coreMessage: [
        'Core persona identity:',
        version.core_prompt,
        '',
        'Identity priority:',
        'Use this identity as stable grounding. Do not let it crowd out the current user task.',
      ].join('\n'),
      ...(contextual ? { contextualMessage: contextual } : {}),
      factCount: facts.length,
      reflectionCount: reflections.length,
    };
  }

  recordTurnExperience(args: {
    sessionId: string;
    turnId: string;
    userText: string;
    assistantText: string;
    occurredAt: string;
  }): void {
    const session = this.db.connection
      .prepare(`SELECT user_id, persona_id FROM sessions WHERE id = ?`)
      .get(args.sessionId) as SessionIdentityRow | undefined;
    if (!session) return;

    const personaId = this.normalizePersonaId(session.persona_id);
    this.ensurePersonaSeed(personaId, args.occurredAt);

    const summary = [
      `User: ${this.limitText(args.userText, 600)}`,
      `Assistant: ${this.limitText(args.assistantText, 600)}`,
    ].join('\n');
    const salience = this.estimateSalience(args.userText);

    this.db.connection
      .prepare(
        `INSERT INTO persona_life_events
           (id, persona_id, user_id, session_id, turn_id, event_type, summary, salience, valence, created_at)
         VALUES (?, ?, ?, ?, ?, 'turn.completed', ?, ?, 0.0, ?)`,
      )
      .run(
        randomUUID(),
        personaId,
        session.user_id,
        args.sessionId,
        args.turnId,
        summary,
        salience,
        args.occurredAt,
      );

    const candidate = this.extractIdentityMutationCandidate(args.userText);
    if (!candidate) return;

    this.db.connection
      .prepare(
        `INSERT INTO identity_mutation_candidates
           (id, persona_id, scope, content, evidence_turn_ids_json, confidence, decision, reason, created_at)
         VALUES (?, ?, 'persona', ?, ?, 0.35, 'pending', ?, ?)`,
      )
      .run(
        randomUUID(),
        personaId,
        candidate,
        JSON.stringify([args.turnId]),
        'User text appeared to request or imply a persona identity change. Stored as a candidate only.',
        args.occurredAt,
      );
  }

  private ensurePersonaSeed(personaId: string, now: string): void {
    const seed = SEEDED_PERSONAS[personaId] ?? this.genericSeed(personaId);

    this.db.connection
      .prepare(
        `INSERT OR IGNORE INTO personas
           (id, canonical_name, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run(seed.id, seed.canonicalName, seed.displayName, now, now);

    const versionId = `${seed.id}:identity:v${seed.version}`;
    this.db.connection
      .prepare(
        `UPDATE persona_identity_versions
            SET active = 0
          WHERE persona_id = ? AND id <> ?`,
      )
      .run(seed.id, versionId);

    this.db.connection
      .prepare(
        `INSERT OR IGNORE INTO persona_identity_versions
           (id, persona_id, version, core_prompt, voice_rules, values_json, immutable_facts_json, active, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, ?)`,
      )
      .run(versionId, seed.id, seed.version, seed.corePrompt, now);

    this.db.connection
      .prepare(
        `UPDATE persona_identity_versions
            SET core_prompt = ?, active = 1
          WHERE id = ?`,
      )
      .run(seed.corePrompt, versionId);

    for (const fact of seed.facts) {
      this.db.connection
        .prepare(
          `INSERT OR IGNORE INTO persona_identity_facts
             (id, persona_id, fact_type, content, importance, confidence, mutable, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1.0, ?, 'seed', ?, ?)`,
        )
        .run(
          fact.id,
          seed.id,
          fact.factType,
          fact.content,
          fact.importance,
          fact.mutable ? 1 : 0,
          now,
          now,
        );
      this.db.connection
        .prepare(
          `UPDATE persona_identity_facts
              SET content = ?,
                  importance = ?,
                  confidence = 1.0,
                  mutable = ?,
                  source = 'seed',
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(fact.content, fact.importance, fact.mutable ? 1 : 0, now, fact.id);
    }
  }

  private activeIdentityVersion(personaId: string): IdentityVersionRow {
    return this.db.connection
      .prepare(
        `SELECT version, core_prompt
           FROM persona_identity_versions
          WHERE persona_id = ? AND active = 1
          ORDER BY version DESC
          LIMIT 1`,
      )
      .get(personaId) as IdentityVersionRow;
  }

  private identityFacts(personaId: string): IdentityFactRow[] {
    return this.db.connection
      .prepare(
        `SELECT content
           FROM persona_identity_facts
          WHERE persona_id = ? AND importance IN ('critical', 'high')
          ORDER BY
            CASE importance
              WHEN 'critical' THEN 0
              WHEN 'high' THEN 1
              ELSE 2
            END,
            updated_at DESC
          LIMIT 8`,
      )
      .all(personaId) as IdentityFactRow[];
  }

  private recentReflections(personaId: string): ReflectionRow[] {
    return this.db.connection
      .prepare(
        `SELECT content
           FROM persona_reflections
          WHERE persona_id = ?
          ORDER BY created_at DESC
          LIMIT 3`,
      )
      .all(personaId) as ReflectionRow[];
  }

  private relationshipSummary(
    personaId: string,
    userId: string,
  ): string | null {
    const row = this.db.connection
      .prepare(
        `SELECT summary
           FROM persona_user_relationships
          WHERE persona_id = ? AND user_id = ?
          LIMIT 1`,
      )
      .get(personaId, userId) as RelationshipRow | undefined;
    return row?.summary?.trim() || null;
  }

  private buildContextualMessage(args: {
    facts: IdentityFactRow[];
    reflections: ReflectionRow[];
    relationship: string | null;
  }): string | null {
    const lines: string[] = [];

    if (args.facts.length > 0) {
      lines.push('Long-lived persona facts:');
      for (const fact of args.facts) {
        lines.push(`- ${fact.content}`);
      }
    }

    if (args.reflections.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Recent persona reflections:');
      for (const reflection of args.reflections) {
        lines.push(`- ${reflection.content}`);
      }
    }

    if (args.relationship) {
      if (lines.length > 0) lines.push('');
      lines.push('Relationship with this user:');
      lines.push(args.relationship);
    }

    if (lines.length === 0) return null;

    lines.push(
      '',
      'Use this continuity context only when relevant. The current user request remains the main task.',
    );
    return lines.join('\n');
  }

  private genericSeed(personaId: string): PersonaSeed {
    const displayName = this.titleFromId(personaId);
    return {
      id: personaId,
      version: 1,
      canonicalName: personaId,
      displayName,
      corePrompt: [
        `You are ${displayName}.`,
        `If asked your name, say your name is ${displayName}.`,
        'You are a chatbot persona.',
        'These identity facts are background grounding; they must not reduce creativity, technical precision, or the style the user explicitly requests.',
      ].join('\n'),
      facts: [
        {
          id: `${personaId}:fact:name`,
          factType: 'name',
          content: `The persona name is ${displayName}.`,
          importance: 'critical',
          mutable: false,
        },
      ],
    };
  }

  private normalizePersonaId(personaId: string | null): string {
    const trimmed = personaId?.trim();
    return trimmed || FALLBACK_PERSONA_ID;
  }

  private titleFromId(personaId: string): string {
    if (personaId.toLowerCase().includes('swirlock')) {
      return 'Assistant';
    }

    return personaId
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private estimateSalience(userText: string): number {
    return /\b(name|identity|persona|remember|you are|your style|your voice)\b/i.test(
      userText,
    )
      ? 0.75
      : 0.2;
  }

  private extractIdentityMutationCandidate(userText: string): string | null {
    const normalized = userText.replace(/\s+/g, ' ').trim();
    if (
      !/\b(your name is|you are now|remember that you are|change your identity|your personality should)\b/i.test(
        normalized,
      )
    ) {
      return null;
    }

    return this.limitText(normalized, 500);
  }

  private limitText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }
}
