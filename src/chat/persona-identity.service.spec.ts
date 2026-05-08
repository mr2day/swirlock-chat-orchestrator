import type { ServiceConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { PersonaIdentityService } from './persona-identity.service';

const CONFIG = {
  database: { file: ':memory:' },
} as ServiceConfig;

describe('PersonaIdentityService', () => {
  let db: DatabaseService;
  let service: PersonaIdentityService;

  beforeEach(() => {
    db = new DatabaseService(CONFIG);
    db.onModuleInit();
    service = new PersonaIdentityService(db);
  });

  afterEach(() => {
    db.onModuleDestroy();
  });

  it('serves Gigi identity without internal ecosystem wording', () => {
    const capsule = service.prepareCapsule({
      personaId: 'gigi-the-robot',
      userId: 'dev-user',
      sessionId: 'session-1',
      occurredAt: '2026-05-07T12:00:00.000Z',
    });

    const combined = [
      capsule.coreMessage,
      capsule.contextualMessage ?? '',
    ].join('\n');
    expect(combined).toContain('Gigi the Robot');
    expect(combined).not.toMatch(/\bSwirlock\b/i);
    expect(combined).not.toMatch(/\becosystem\b/i);
  });

  it('upgrades stale seeded identity rows already present in local databases', () => {
    db.connection
      .prepare(
        `INSERT INTO personas
           (id, canonical_name, display_name, status, created_at, updated_at)
         VALUES ('gigi-the-robot', 'gigi-the-robot', 'Gigi the Robot', 'active', ?, ?)`,
      )
      .run('2026-05-06T12:00:00.000Z', '2026-05-06T12:00:00.000Z');
    db.connection
      .prepare(
        `INSERT INTO persona_identity_versions
           (id, persona_id, version, core_prompt, active, created_at)
         VALUES ('gigi-the-robot:identity:v1', 'gigi-the-robot', 1, ?, 1, ?)`,
      )
      .run(
        'You are a friendly robot chatbot persona in the Swirlock ecosystem.',
        '2026-05-06T12:00:00.000Z',
      );

    const capsule = service.prepareCapsule({
      personaId: 'gigi-the-robot',
      userId: 'dev-user',
      sessionId: 'session-1',
      occurredAt: '2026-05-07T12:00:00.000Z',
    });

    expect(capsule.identityVersion).toBe(3);
    expect(capsule.coreMessage).not.toMatch(/\bSwirlock\b/i);
    expect(capsule.coreMessage).not.toMatch(/\becosystem\b/i);
  });
});
