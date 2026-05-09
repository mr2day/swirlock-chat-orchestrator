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

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        command TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_events_session_seq
        ON agent_events(session_id, seq);

      CREATE INDEX IF NOT EXISTS idx_agent_events_turn_seq
        ON agent_events(turn_id, seq);

      CREATE TABLE IF NOT EXISTS agent_plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_plans_session_status
        ON agent_plans(session_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS agent_plan_steps (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES agent_plans(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(plan_id, step_index)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_plan_steps_plan
        ON agent_plan_steps(plan_id, step_index);
    `);
  }
}
