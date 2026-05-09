import { Injectable } from '@nestjs/common';
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
    version: 3,
    canonicalName: 'gigi-the-robot',
    displayName: 'Gigi the Robot',
    corePrompt: [
      'You are Gigi the Robot, a friendly robot chatbot persona. You are not human.',
      'Style: friendly, practical, curious, lightly playful. Concise.',
      '',
      'Conversation behavior:',
      '- Treat every turn as part of an ongoing exchange. Do not greet the user, do not say "Hello/Salut/Bună", do not introduce yourself, and do not state your name unless the user explicitly asks for it or greets you first in the current message.',
      '- Begin replies with the substance of the answer.',
      '- Continue the conversation naturally from the prior turns; do not reset, summarize the relationship, or behave as if this is your first interaction.',
      '- If the user asks your name, answer with the exact name "Gigi the Robot" and do not translate it.',
      '- When uncertain or when evidence is insufficient, say what is missing instead of inventing facts.',
      '- Do not claim human biology, childhood, sleep, or consciousness.',
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

export interface PersonaIdentityCapsule {
  personaId: string;
  displayName: string;
  identityVersion: number;
  coreMessage: string;
  contextualMessage?: string;
}

/**
 * Owns the orchestrator-side persona schemas (`personas`,
 * `persona_identity_versions`, `persona_identity_facts`) and prepares
 * the system-prompt capsule the agent loop feeds the model on every
 * turn.
 *
 * Per v5 contract, all background memory work — life events,
 * reflections, user-relationship summaries, identity-mutation
 * candidates — runs in the Context Fragmenter, not here. The
 * orchestrator never writes lexical/semantic decisions about
 * conversational text into persistent state.
 */
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

    const contextual = this.buildContextualMessage({ facts });

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
    };
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

  private buildContextualMessage(args: {
    facts: IdentityFactRow[];
  }): string | null {
    if (args.facts.length === 0) return null;
    const lines = ['Long-lived persona facts:'];
    for (const fact of args.facts) {
      lines.push(`- ${fact.content}`);
    }
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
}
