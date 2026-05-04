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
    `);
  }
}
