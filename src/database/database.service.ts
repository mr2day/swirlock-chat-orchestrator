import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';

export type Db = Database.Database;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DatabaseService.name);
  private db?: Db;

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  onModuleInit(): void {
    const file = this.cfg.database.file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.log.log(`SQLite ready at ${file}`);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  get connection(): Db {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        persona_id TEXT,
        channel TEXT,
        client_version TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        parts_json TEXT,
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_seq
        ON messages(session_id, seq);

      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS persona_identity_versions (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        core_prompt TEXT NOT NULL,
        voice_rules TEXT,
        values_json TEXT,
        immutable_facts_json TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(persona_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_persona_identity_active
        ON persona_identity_versions(persona_id, active);

      CREATE TABLE IF NOT EXISTS persona_identity_facts (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        fact_type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        mutable INTEGER NOT NULL DEFAULT 1,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_persona_identity_facts_lookup
        ON persona_identity_facts(persona_id, importance, fact_type);

      CREATE TABLE IF NOT EXISTS persona_life_events (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        user_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 0.0,
        valence REAL NOT NULL DEFAULT 0.0,
        embedding_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_persona_life_events_recent
        ON persona_life_events(persona_id, created_at);

      CREATE TABLE IF NOT EXISTS persona_reflections (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        source_event_ids_json TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_persona_reflections_recent
        ON persona_reflections(persona_id, created_at);

      CREATE TABLE IF NOT EXISTS persona_user_relationships (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        summary TEXT,
        preferences_json TEXT,
        boundaries_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(persona_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS persona_identity_snapshots (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        user_id TEXT,
        snapshot_type TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER,
        identity_version INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_persona_identity_snapshots_lookup
        ON persona_identity_snapshots(persona_id, user_id, snapshot_type, created_at);

      CREATE TABLE IF NOT EXISTS identity_mutation_candidates (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        evidence_turn_ids_json TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        decision TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_identity_mutation_candidates_pending
        ON identity_mutation_candidates(persona_id, decision, created_at);
    `);
  }
}
